import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net, { type AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { FrameReader, KnxConnector, parseGateway, SERVICE } from '../src/lib/knx';
import { Mux, type TunnelStream } from '../src/lib/tunnel';

const silent = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    silly() {},
    level: 'info',
} as unknown as ioBroker.Logger;

function frame(service: number, body: number[]): Buffer {
    const buf = Buffer.alloc(6 + body.length);
    buf[0] = 6;
    buf[1] = 0x10;
    buf.writeUInt16BE(service, 2);
    buf.writeUInt16BE(buf.length, 4);
    Buffer.from(body).copy(buf, 6);
    return buf;
}

const TCP_ZERO = [8, 2, 0, 0, 0, 0, 0, 0];
/** CRI of a tunnel on the link layer */
const CRI = [4, 4, 2, 0];

/** Two ends of a tunnel in memory: what ETS writes on `ets` arrives as the stream the agent relays */
function tunnelPair(onStream: (s: TunnelStream) => void): TunnelStream {
    let agent: Mux | null = null;
    const server = new Mux(f => agent!.receive(f));
    agent = new Mux(f => server.receive(f), onStream);
    return server.open();
}

function nextMessage(socket: dgram.Socket): Promise<{ msg: Buffer; rinfo: dgram.RemoteInfo }> {
    return new Promise(resolve => socket.once('message', (msg, rinfo) => resolve({ msg, rinfo })));
}

function nextFrame(stream: TunnelStream): Promise<Buffer> {
    return new Promise(resolve => {
        const reader = new FrameReader(f => {
            stream.off('data', onData);
            resolve(f);
        });
        const onData = (c: Buffer): void => void reader.push(c);
        stream.on('data', onData);
    });
}

async function bound(socket: dgram.Socket): Promise<number> {
    await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
    return socket.address().port;
}

describe('KNX for ETS', () => {
    it('reads the gateway address', () => {
        assert.deepEqual(parseGateway('192.168.1.20'), { host: '192.168.1.20', port: 3671, transport: 'auto' });
        assert.deepEqual(parseGateway(' knx-gw.local:3672 ', 'udp'), { host: 'knx-gw.local', port: 3672, transport: 'udp' });
        assert.equal(parseGateway(''), null);
        assert.equal(parseGateway('http://192.168.1.20'), null);
        assert.equal(parseGateway('192.168.1.20:99999'), null);
        assert.equal(parseGateway('a b'), null);
        assert.equal(parseGateway(undefined), null);
    });

    it('splits the stream into frames, also across chunks', () => {
        const frames: Buffer[] = [];
        const reader = new FrameReader(f => frames.push(f));
        const a = frame(SERVICE.TUNNELLING_ACK, [4, 1, 0, 0]);
        const b = frame(SERVICE.CONNECTIONSTATE_REQUEST, [1, 0, ...TCP_ZERO]);
        const both = Buffer.concat([a, b]);
        assert.equal(reader.push(both.subarray(0, 7)), true);
        assert.equal(frames.length, 0);
        assert.equal(reader.push(both.subarray(7)), true);
        assert.deepEqual(frames, [a, b]);
        assert.equal(new FrameReader(() => {}).push(Buffer.from('GET / HTTP/1.1\r\n')), false);
    });

    it('translates to a gateway with UDP only', async () => {
        const control = dgram.createSocket('udp4');
        const data = dgram.createSocket('udp4');
        const controlPort = await bound(control);
        const dataPort = await bound(data);
        const connector = new KnxConnector({ host: '127.0.0.1', port: controlPort, transport: 'udp' }, { log: silent });
        const ets = tunnelPair(s => connector.relay(s));

        // CONNECT_REQUEST: the HPAIs of ETS (TCP, 0.0.0.0:0) become the address of the agent
        let got = nextMessage(control);
        ets.write(frame(SERVICE.CONNECT_REQUEST, [...TCP_ZERO, ...TCP_ZERO, ...CRI]));
        const { msg: connect, rinfo } = await got;
        assert.equal(connect.readUInt16BE(2), SERVICE.CONNECT_REQUEST);
        for (const offset of [6, 14]) {
            assert.equal(connect[offset + 1], 1, 'UDP');
            assert.equal([...connect.subarray(offset + 2, offset + 6)].join('.'), '127.0.0.1');
            assert.equal(connect.readUInt16BE(offset + 6), rinfo.port);
        }

        // CONNECT_RESPONSE: channel 7, data endpoint of the gateway; ETS sees TCP, 0.0.0.0:0
        const response = nextFrame(ets);
        control.send(
            frame(SERVICE.CONNECT_RESPONSE, [7, 0, 8, 1, 127, 0, 0, 1, dataPort >> 8, dataPort & 0xff, 4, 4, 0x11, 0x05]),
            rinfo.port,
            '127.0.0.1',
        );
        const r = await response;
        assert.equal(r.readUInt16BE(2), SERVICE.CONNECT_RESPONSE);
        assert.deepEqual([...r.subarray(8, 16)], TCP_ZERO);

        // TUNNELLING_REQUEST of channel 7 goes to the data endpoint
        got = nextMessage(data);
        const tunnelling = frame(SERVICE.TUNNELLING_REQUEST, [4, 7, 0, 0, 0x11, 0, 0xbc, 0xe0, 0, 0, 0x08, 0x01, 1, 0, 0x81]);
        ets.write(tunnelling);
        assert.deepEqual((await got).msg, tunnelling);

        // ETS goes away: the agent frees the tunnel of the gateway
        got = nextMessage(control);
        ets.destroy();
        const { msg: disconnect } = await got;
        assert.equal(disconnect.readUInt16BE(2), SERVICE.DISCONNECT_REQUEST);
        assert.equal(disconnect[6], 7);
        control.close();
        data.close();
    });

    it('passes the bytes to a gateway with TCP as they are', async () => {
        const received: Buffer[] = [];
        const gateway = net.createServer(socket => {
            socket.on('data', c => {
                received.push(c);
                socket.write(frame(SERVICE.CONNECT_RESPONSE, [3, 0, ...TCP_ZERO, 4, 4, 0x11, 0x05]));
            });
        });
        await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
        const port = (gateway.address() as AddressInfo).port;
        const connector = new KnxConnector({ host: '127.0.0.1', port, transport: 'auto' }, { log: silent });
        const ets = tunnelPair(s => connector.relay(s));
        const request = frame(SERVICE.CONNECT_REQUEST, [...TCP_ZERO, ...TCP_ZERO, ...CRI]);
        const response = nextFrame(ets);
        ets.write(request);
        const r = await response;
        assert.equal(r[6], 3);
        assert.deepEqual(Buffer.concat(received), request);
        ets.destroy();
        gateway.close();
    });

    it('takes UDP when the gateway has no TCP (auto)', async () => {
        const control = dgram.createSocket('udp4');
        const port = await bound(control);
        // nothing listens on TCP at this port: refused right away
        const connector = new KnxConnector({ host: '127.0.0.1', port, transport: 'auto' }, { log: silent });
        const ets = tunnelPair(s => connector.relay(s));
        const got = nextMessage(control);
        ets.write(frame(SERVICE.DESCRIPTION_REQUEST, TCP_ZERO));
        const { msg } = await got;
        assert.equal(msg.readUInt16BE(2), SERVICE.DESCRIPTION_REQUEST);
        assert.equal(msg[7], 1, 'UDP');
        ets.destroy();
        control.close();
    });
});
