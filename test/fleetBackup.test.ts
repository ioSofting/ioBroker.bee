import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { recentOffDeviceBackup } from '../src/lib/backup';
import { configHash, encryptBackup, objectForHash, uploadParts, uploadUrlAllowed } from '../src/lib/fleetBackup';
import { BACKUP_HEADER_BYTES, BACKUP_MAGIC, BACKUP_TAG_BYTES } from '../src/lib/protocol';

const temp = mkdtempSync(join(tmpdir(), 'bee-fleet-backup-'));
after(() => rmSync(temp, { recursive: true, force: true }));

/** A tar as node-tar writes it for `iobroker backup`: ustar, long names as pax header */
function tar(entries: [string, string | Buffer][]): Buffer {
    const blocks: Buffer[] = [];
    const header = (name: string, size: number, type: string): Buffer => {
        const h = Buffer.alloc(512);
        h.write(name.slice(0, 100), 0, 'utf8');
        h.write('0000644\0', 100);
        h.write('0000000\0', 108);
        h.write('0000000\0', 116);
        h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
        h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
        h.write('        ', 148);
        h.write(type, 156);
        h.write('ustar\0', 257);
        h.write('00', 263);
        let sum = 0;
        for (const b of h) {
            sum += b;
        }
        h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
        return h;
    };
    const add = (name: string, data: Buffer, type: string): void => {
        blocks.push(header(name, data.length, type), data, Buffer.alloc((512 - (data.length % 512)) % 512));
    };
    for (const [name, content] of entries) {
        const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
        if (name.length > 100) {
            const record = (len: number): string => `${len} path=${name}\n`;
            let len = record(0).length;
            len = record(len).length;
            add(`PaxHeader/${name.slice(0, 80)}`, Buffer.from(record(len)), 'x');
        }
        add(name, data, '0');
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

const objects = (list: Record<string, unknown>[]): string => list.map(o => JSON.stringify(o)).join('\n') + '\n';
const BASE = [
    { _id: 'system.config', type: 'config', common: { language: 'de' }, native: {}, ts: 1, from: 'system.host.pi', user: 'system.user.admin' },
    { _id: 'system.host.pi', type: 'host', common: { name: 'pi', installedVersion: '7.0.7' }, native: { process: { memory: 1 } }, ts: 1 },
    { _id: 'system.repositories', type: 'config', common: {}, native: { repositories: { stable: { json: { time: 1 } } } } },
    { _id: 'javascript.0.scriptEnabled', type: 'state', common: { name: 'x', role: 'switch' }, native: {} },
];

async function archive(name: string, opts: { objs?: Record<string, unknown>[]; states?: string; view?: string; zigbee?: string } = {}): Promise<string> {
    const file = join(temp, name);
    const long = `backup/files/vis-2.0/${'very-long-project-name-'.repeat(5)}/vis-views.json`;
    writeFileSync(
        file,
        gzipSync(
            tar([
                ['backup/config.json', '{"system":{"hostname":""}}'],
                ['backup/objects.jsonl', objects(opts.objs ?? BASE)],
                ['backup/states.jsonl', opts.states ?? '{"id":"a","state":{"val":1}}\n'],
                [long, opts.view ?? '{"main":{}}'],
                ['backup/zigbee_0/database.db', opts.zigbee ?? 'devices v1'],
            ]),
        ),
    );
    return file;
}

describe('fleet backup on the device', () => {
    it('hashes the configuration: the same whatever the states, times, caches and hardware facts', async () => {
        const base = await configHash(await archive('a.tar.gz'));
        assert.match(base, /^[0-9a-f]{64}$/);
        const same = [
            await archive('b.tar.gz', { states: '{"id":"a","state":{"val":2}}\n' }),
            await archive('c.tar.gz', {
                objs: [
                    { ...BASE[0], ts: 99, from: 'system.adapter.admin.0', user: 'system.user.other' },
                    { ...BASE[1], native: { process: { memory: 2 } } },
                    { ...BASE[2], native: { repositories: { stable: { json: { time: 2 } } } } },
                    BASE[3],
                ],
            }),
            // another order of objects and of keys
            await archive('d.tar.gz', { objs: [BASE[3], { native: {}, common: { language: 'de' }, type: 'config', _id: 'system.config' }, BASE[1], BASE[2]] }),
            // a data folder of an instance changes all the time
            await archive('e.tar.gz', { zigbee: 'devices v2, last seen now' }),
        ];
        for (const file of same) {
            assert.equal(await configHash(file), base, file);
        }
        const changed = [
            await archive('f.tar.gz', { objs: [{ ...BASE[0], common: { language: 'en' } }, BASE[1], BASE[2], BASE[3]] }),
            await archive('g.tar.gz', { objs: [...BASE, { _id: 'zigbee.0.00158d', type: 'device', common: { name: 'Lampe' }, native: {} }] }),
            await archive('h.tar.gz', { view: '{"main":{"widgets":1}}' }),
        ];
        for (const file of changed) {
            assert.notEqual(await configHash(file), base, file);
        }
    });

    it('keeps objects it cannot read as they are', () => {
        assert.equal(objectForHash('not json'), 'not json');
        assert.equal(objectForHash('{"_id":"system.licenses","native":{}}'), null);
        assert.equal(objectForHash('{"b":1,"a":2,"ts":3}'), '{"a":2,"b":1}');
    });

    it('encrypts as the fleet decrypts it', async () => {
        const plain = randomBytes(200_000);
        const src = join(temp, 'plain.tar.gz');
        writeFileSync(src, plain);
        const key = randomBytes(32);
        const { size, sha256 } = await encryptBackup(src, join(temp, 'x.bee'), key, 'bak_1');
        const file = readFileSync(join(temp, 'x.bee'));
        assert.equal(size, file.length);
        assert.equal(size, plain.length + BACKUP_HEADER_BYTES + BACKUP_TAG_BYTES);
        assert.match(sha256, /^[0-9a-f]{64}$/);
        assert.equal(file.subarray(0, 8).toString('latin1'), BACKUP_MAGIC);
        const d = createDecipheriv('aes-256-gcm', key, file.subarray(8, BACKUP_HEADER_BYTES));
        d.setAAD(Buffer.concat([file.subarray(0, BACKUP_HEADER_BYTES), Buffer.from('bak_1')]));
        d.setAuthTag(file.subarray(file.length - BACKUP_TAG_BYTES));
        assert.deepEqual(Buffer.concat([d.update(file.subarray(BACKUP_HEADER_BYTES, file.length - BACKUP_TAG_BYTES)), d.final()]), plain);
    });

    it('uploads part by part, tries a part again after an error, gives up on a refused address', async () => {
        const got = new Map<number, Buffer>();
        let failures = 1;
        const server: Server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
                const n = Number(new URL(req.url!, 'http://x').searchParams.get('partNumber'));
                if (n === 9) {
                    res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>');
                } else if (n === 2 && failures-- > 0) {
                    res.writeHead(503).end();
                } else {
                    got.set(n, Buffer.concat(chunks));
                    res.writeHead(200, { ETag: `"etag-${n}"` }).end();
                }
            });
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as { port: number }).port;
        try {
            const file = join(temp, 'up.bee');
            const data = randomBytes(5 * 1024 * 1024 * 2 + 1000);
            writeFileSync(file, data);
            const parts = [1, 2, 3, 4].map(n => `http://127.0.0.1:${port}/b/k?partNumber=${n}`);
            const progress: string[] = [];
            const etags = await uploadParts(
                file,
                data.length,
                { parts, partSize: 5 * 1024 * 1024, expiresAt: Date.now() + 60_000 },
                { delays: [10], onPart: (done, total) => progress.push(`${done}/${total}`) },
            );
            assert.deepEqual(etags, ['"etag-1"', '"etag-2"', '"etag-3"']);
            assert.deepEqual(progress, ['1/3', '2/3', '3/3']);
            assert.deepEqual(Buffer.concat([got.get(1)!, got.get(2)!, got.get(3)!]), data);

            await assert.rejects(
                uploadParts(file, 10, { parts: [`http://127.0.0.1:${port}/b/k?partNumber=9`], partSize: 5 * 1024 * 1024, expiresAt: Date.now() + 60_000 }, { delays: [10] }),
                /Teil 1 von 1: Speicher antwortet 403 AccessDenied/,
            );
            await assert.rejects(
                uploadParts(file, data.length, { parts: parts.slice(0, 2), partSize: 5 * 1024 * 1024, expiresAt: Date.now() + 60_000 }),
                /Zu groß: 3 Teile, erlaubt sind 2/,
            );
        } finally {
            server.close();
        }
    });

    it('uploads only over https, or to this machine', () => {
        assert.equal(uploadUrlAllowed('https://bucket.s3.eu-west-1.amazonaws.com/k?x=1'), true);
        assert.equal(uploadUrlAllowed('http://127.0.0.1:9000/b/k'), true);
        assert.equal(uploadUrlAllowed('http://192.168.1.5:9000/b/k'), false);
        assert.equal(uploadUrlAllowed('file:///etc/passwd'), false);
    });

    it('a current fleet backup counts as outside the device for Node.js', () => {
        const now = Date.parse('2026-11-28T12:00:00Z');
        const none = { offDevice: false, backitup: null };
        assert.equal(recentOffDeviceBackup(none, now), false);
        assert.equal(recentOffDeviceBackup(none, now, now - 24 * 3600_000), true);
        assert.equal(recentOffDeviceBackup(none, now, now - 3 * 24 * 3600_000), false);
    });
});
