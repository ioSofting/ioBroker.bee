import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_WEB_DEVICES } from '../src/lib/protocol';
import { describeWebDevices, parseWebAddress, resolveWebDevice, webDevices } from '../src/lib/web';

describe('web interfaces of devices in the network', () => {
    it('reads IP:port, with HTTPS from the scheme or port 443', () => {
        assert.deepEqual(parseWebAddress('192.168.0.1'), { address: '192.168.0.1', port: 80, secure: false });
        assert.deepEqual(parseWebAddress(' 192.168.0.20:8080 '), { address: '192.168.0.20', port: 8080, secure: false });
        assert.deepEqual(parseWebAddress('https://192.168.0.30'), { address: '192.168.0.30', port: 443, secure: true });
        assert.deepEqual(parseWebAddress('HTTPS://10.1.2.3:8443/'), { address: '10.1.2.3', port: 8443, secure: true });
        assert.deepEqual(parseWebAddress('172.20.0.5:443'), { address: '172.20.0.5', port: 443, secure: true });
        assert.deepEqual(parseWebAddress('http://192.168.0.5:443'), { address: '192.168.0.5', port: 443, secure: false });
        assert.deepEqual(parseWebAddress('127.0.0.1:1880'), { address: '127.0.0.1', port: 1880, secure: false });
        assert.deepEqual(parseWebAddress('169.254.1.1'), { address: '169.254.1.1', port: 80, secure: false });
        assert.deepEqual(parseWebAddress('Fritz.Box'), { address: 'fritz.box', port: 80, secure: false });
    });

    it('takes no public address, no path and nothing that is not an address', () => {
        assert.match(parseWebAddress('8.8.8.8') as string, /nur private Adressen/);
        assert.match(parseWebAddress('100.72.1.9:80') as string, /nur private Adressen/);
        assert.match(parseWebAddress('192.168.0.1:70000') as string, /Port von 1 bis 65535/);
        assert.match(parseWebAddress('192.168.0.300') as string, /keine IPv4-Adresse/);
        assert.match(parseWebAddress('192.168.0.1/admin') as string, /als IP:Port angeben/);
        assert.match(parseWebAddress('ftp://192.168.0.1') as string, /als IP:Port angeben/);
        assert.match(parseWebAddress('user@192.168.0.1') as string, /als IP:Port angeben/);
        assert.match(parseWebAddress('[::1]:80') as string, /als IP:Port angeben/);
        assert.match(parseWebAddress('ab_c.local') as string, /kein Hostname/);
        assert.equal(parseWebAddress(''), 'Adresse fehlt');
    });

    it('reads the table: names once, empty lines skipped, reasons for the rest', () => {
        const { devices, errors } = webDevices([
            { name: 'Router', address: '192.168.0.1' },
            { name: '', address: '' },
            { name: ' Wechselrichter ', address: '192.168.0.20:8080' },
            { name: 'router', address: '192.168.0.2' },
            { name: 'Cloud', address: '8.8.8.8' },
            { name: '', address: '192.168.0.9' },
            { name: 'x'.repeat(61), address: '192.168.0.9' },
            null,
        ]);
        assert.deepEqual(devices, [
            { name: 'Router', address: '192.168.0.1', port: 80, secure: false },
            { name: 'Wechselrichter', address: '192.168.0.20', port: 8080, secure: false },
        ]);
        assert.equal(errors.length, 4);
        assert.match(errors[0], /^Zeile 4 \(router\): der Name steht schon/);
        assert.match(errors[1], /^Zeile 5 \(Cloud\): 8\.8\.8\.8: nur private/);
        assert.match(errors[2], /^Zeile 6: Name fehlt/);
        assert.match(errors[3], /länger als 60 Zeichen/);
        assert.deepEqual(webDevices(undefined), { devices: [], errors: [] });
        assert.deepEqual(webDevices('quatsch'), { devices: [], errors: [] });

        const many = Array.from({ length: MAX_WEB_DEVICES + 1 }, (_, i) => ({ name: `Gerät ${i}`, address: `192.168.0.${i + 1}` }));
        const capped = webDevices(many);
        assert.equal(capped.devices.length, MAX_WEB_DEVICES);
        assert.match(capped.errors[0], /höchstens 32/);
    });

    it('tells the fleet management name, address, port and HTTPS', () => {
        const { devices } = webDevices([{ name: 'Kamera', address: 'https://192.168.0.30' }]);
        assert.deepEqual(describeWebDevices(devices), [
            { instance: 'Kamera', port: 443, secure: true, auth: false, address: '192.168.0.30' },
        ]);
    });

    it('resolves a host name only to a private address or this system', async () => {
        const device = { name: 'NAS', address: 'nas.local', port: 5001, secure: true };
        assert.deepEqual(await resolveWebDevice(device, async () => '192.168.0.40'), {
            instance: 'NAS',
            host: '192.168.0.40',
            port: 5001,
            secure: true,
            auth: false,
            servername: 'nas.local',
        });
        assert.match(
            (await resolveWebDevice(device, async () => '93.184.216.34')) as string,
            /nas\.local zeigt auf 93\.184\.216\.34, keine private Adresse/,
        );
        const missing = Object.assign(new Error('getaddrinfo ENOTFOUND nas.local'), { code: 'ENOTFOUND' });
        assert.match(
            (await resolveWebDevice(device, () => Promise.reject(missing))) as string,
            /nas\.local ist im Netz nicht zu finden \(ENOTFOUND\)/,
        );
        // an IP address is not resolved, and HTTP needs no SNI
        const router = { name: 'Router', address: '192.168.0.1', port: 80, secure: false };
        assert.deepEqual(await resolveWebDevice(router, () => Promise.reject(new Error('not asked'))), {
            instance: 'Router',
            host: '192.168.0.1',
            port: 80,
            secure: false,
            auth: false,
        });
    });
});
