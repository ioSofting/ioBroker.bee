import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { describe, it } from 'node:test';
import { addressRefusal, lanInfo, ownNetworks, parseNetworks, parsePorts, relayTcp, targetRefusal } from '../src/lib/lan';
import { Mux, metaPort, portMeta, type TunnelStream } from '../src/lib/tunnel';

const iface = (address: string, cidr: string, internal = false): NetworkInterfaceInfo =>
    ({ address, cidr, family: 'IPv4', internal, netmask: '', mac: '' }) as NetworkInterfaceInfo;

const IFACES = {
    lo: [iface('127.0.0.1', '127.0.0.1/8', true)],
    eth0: [iface('192.168.0.50', '192.168.0.50/24')],
    wwan0: [iface('100.72.1.9', '100.72.1.9/30')],
};

describe('devices in the network', () => {
    it('knows the own addresses and private subnets', () => {
        assert.deepEqual(ownNetworks(IFACES), { addresses: ['192.168.0.50', '100.72.1.9'], subnets: ['192.168.0.0/24'] });
    });

    it('reads networks and ports of the instance, only private networks', () => {
        assert.deepEqual(parseNetworks('192.168.0.7/24, 10.1.2.3 ; 8.8.8.0/24, 0.0.0.0/0, 172.20.0.0/16, quatsch'), [
            '192.168.0.0/24',
            '10.1.2.3/32',
            '172.20.0.0/16',
        ]);
        assert.deepEqual(parsePorts('102, 10005 102 x 70000'), [102, 10005]);
        assert.equal(parsePorts(''), null);
        const own = ownNetworks(IFACES);
        assert.deepEqual(lanInfo({ allowLan: true }, own), { devices: true, networks: ['192.168.0.0/24'], ports: null });
        assert.deepEqual(lanInfo({ lanNetworks: '10.0.0.0/8', lanPorts: '102' }, own), { devices: false, networks: ['10.0.0.0/8'], ports: [102] });
    });

    it('reaches only allowed devices, never itself', () => {
        const own = ownNetworks(IFACES);
        const info = lanInfo({ allowLan: true, lanPorts: '102, 10005' }, own);
        const logo = { name: 'LOGO! Heizung', host: '192.168.0.3', ports: [102, 10005] };
        assert.equal(targetRefusal(logo, info, own.addresses), null);
        assert.match(targetRefusal({ ...logo, host: '192.168.1.3' }, info, own.addresses)!, /außerhalb des erlaubten Netzes \(192\.168\.0\.0\/24\)/);
        assert.match(targetRefusal({ ...logo, host: '192.168.0.50' }, info, own.addresses)!, /das Gerät selbst/);
        assert.match(targetRefusal({ ...logo, host: '127.0.0.1' }, info, own.addresses)!, /keine private Adresse/);
        assert.match(targetRefusal({ ...logo, ports: [102, 22] }, info, own.addresses)!, /Port 22 am Gerät nicht erlaubt/);
        assert.match(targetRefusal(logo, { ...info, devices: false }, own.addresses)!, /nicht freigegeben/);
        assert.match(targetRefusal(undefined, info, own.addresses)!, /Kein gültiges Gerät/);
        assert.equal(addressRefusal('192.168.0.10', info, own.addresses), null, 'a KNX gateway of the list');
        assert.match(addressRefusal('knx.local', info, own.addresses)!, /keine IPv4-Adresse/);
    });

    it('carries a stream to the device on the port its OPEN names', async () => {
        // the device: echoes, then closes after "bye"
        const device = createServer(socket => {
            socket.on('data', d => (d.toString() === 'bye' ? socket.end('ciao') : socket.write(Buffer.concat([Buffer.from('echo:'), d]))));
        });
        await new Promise<void>(r => device.listen(0, '127.0.0.1', r));
        const port = (device.address() as AddressInfo).port;
        // server and agent side of the tunnel, wired back to back
        let agent!: Mux;
        let ended: string | undefined = 'not yet';
        const server = new Mux(f => agent.receive(f));
        agent = new Mux(
            f => server.receive(f),
            (stream: TunnelStream) => {
                assert.equal(metaPort(stream.meta), port);
                relayTcp(stream, '127.0.0.1', port, error => (ended = error));
            },
        );
        const stream = server.open(portMeta(port));
        const received: Buffer[] = [];
        stream.on('data', (d: Buffer) => received.push(d));
        const closed = new Promise<void>(r => stream.on('end', () => r()));
        stream.write('hallo');
        await new Promise(r => setTimeout(r, 50));
        stream.write('bye');
        await closed;
        assert.equal(Buffer.concat(received).toString(), 'echo:hallociao');
        await new Promise(r => setTimeout(r, 20));
        stream.destroy();
        await new Promise(r => setTimeout(r, 20));
        assert.equal(ended, undefined, 'ended without error');
        device.close();
    });

    it('reports a device that does not answer', async () => {
        const probe = createServer();
        await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
        const port = (probe.address() as AddressInfo).port;
        await new Promise<void>(r => probe.close(() => r()));
        let agent!: Mux;
        const error = new Promise<string | undefined>(resolve => {
            const server = new Mux(f => agent.receive(f));
            agent = new Mux(
                f => server.receive(f),
                stream => relayTcp(stream, '127.0.0.1', port, resolve),
            );
            server.open(portMeta(port)).on('error', () => {});
        });
        assert.match((await error)!, /ECONNREFUSED/);
    });
});
