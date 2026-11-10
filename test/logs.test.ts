import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { findLogFile, listLogFiles, logDirs, uploadLog, validLogName } from '../src/lib/logs';

const temp = mkdtempSync(join(tmpdir(), 'bee-logs-'));
after(() => rmSync(temp, { recursive: true, force: true }));

describe('logs', () => {
    it('finds the directories of the file transports like js-controller', () => {
        const root = resolve('/opt/iobroker');
        const config = {
            log: {
                transport: {
                    file1: { type: 'file', enabled: true, filename: 'log/iobroker' },
                    syslog1: { type: 'syslog', enabled: false },
                    file2: { type: 'file', filename: '/var/log/iob/iobroker' },
                    file3: { type: 'file', filename: 'log/other' },
                },
            },
        };
        assert.deepEqual(logDirs(config, root), [join(root, 'log'), normalize('/var/log/iob')]);
        assert.deepEqual(logDirs({ log: { transport: { file1: { type: 'file' } } } }, root), [join(root, 'log')]);
        assert.deepEqual(logDirs(null, root), []);
    });

    it('takes only plain names of log files', () => {
        for (const ok of ['iobroker.2026-11-10.log', 'iobroker.2026-11-03.log.gz', 'iobroker.current.log']) {
            assert.equal(validLogName(ok), true, ok);
        }
        for (const bad of ['../iobroker.log', 'a/b.log', '.hidden.log', 'iobroker.json', 'x..log', '', 5, null]) {
            assert.equal(validLogName(bad), false, String(bad));
        }
    });

    it('lists the log files newest first and finds them by name', async () => {
        const a = join(temp, 'a');
        const b = join(temp, 'b');
        mkdirSync(a);
        mkdirSync(b);
        writeFileSync(join(a, 'iobroker.2026-11-09.log'), 'old');
        writeFileSync(join(a, 'iobroker.2026-11-10.log'), 'new line');
        writeFileSync(join(a, 'iobroker-audit.json'), '{}');
        writeFileSync(join(b, 'iobroker.2026-11-01.log.gz'), gzipSync('x'));
        mkdirSync(join(b, 'dir.log'));
        utimesSync(join(a, 'iobroker.2026-11-09.log'), new Date('2026-11-09'), new Date('2026-11-09'));
        utimesSync(join(a, 'iobroker.2026-11-10.log'), new Date('2026-11-10'), new Date('2026-11-10'));
        utimesSync(join(b, 'iobroker.2026-11-01.log.gz'), new Date('2026-11-01'), new Date('2026-11-01'));
        const files = await listLogFiles([a, b, join(temp, 'missing')]);
        assert.deepEqual(
            files.map(f => `${f.name} ${f.size}`),
            ['iobroker.2026-11-10.log 8', 'iobroker.2026-11-09.log 3', `iobroker.2026-11-01.log.gz ${files[2].size}`],
        );
        assert.equal(await findLogFile([a, b], 'iobroker.2026-11-01.log.gz'), join(b, 'iobroker.2026-11-01.log.gz'));
        assert.equal(await findLogFile([a, b], '../a/iobroker.2026-11-10.log'), null);
        assert.equal(await findLogFile([a, b], 'dir.log'), null);
    });

    it('uploads compressed with the ticket, a .gz file as it is', async () => {
        const received: { auth?: string; type?: string; body: Buffer }[] = [];
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (d: Buffer) => chunks.push(d));
            req.on('end', () => {
                received.push({
                    auth: req.headers.authorization,
                    type: req.headers['content-type'],
                    body: Buffer.concat(chunks),
                });
                if (req.headers.authorization === 'Bearer bad') {
                    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Ticket unbekannt"}');
                } else {
                    res.writeHead(200).end('{"ok":true}');
                }
            });
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/device/logs/x`;
        try {
            const plain = join(temp, 'plain.log');
            const text = '2026-11-10 21:59:36.208  - info: host.pi line\n'.repeat(1000);
            writeFileSync(plain, text);
            const sent = await uploadLog(plain, url, 'good', []);
            assert.equal(received[0].auth, 'Bearer good');
            assert.equal(received[0].type, 'application/gzip');
            assert.equal(gunzipSync(received[0].body).toString(), text);
            assert.equal(sent, received[0].body.length);
            assert.ok(sent < text.length / 10, 'compressed');

            const gz = join(temp, 'old.log.gz');
            writeFileSync(gz, gzipSync('already compressed'));
            await uploadLog(gz, url, 'good', []);
            assert.equal(gunzipSync(received[1].body).toString(), 'already compressed');

            await assert.rejects(uploadLog(plain, url, 'bad', []), /HTTP 404 Ticket unbekannt/);
        } finally {
            server.close();
        }
    });
});
