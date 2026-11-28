import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { encryptBackup } from '../src/lib/fleetBackup';
import {
    archiveHasObject,
    decryptBackup,
    downloadBackup,
    restoreRefusal,
    sameSettings,
    spaceNeeded,
    type RestoreFacts,
} from '../src/lib/restore';
import type { RestoreRequest } from '../src/lib/protocol';

const temp = mkdtempSync(join(tmpdir(), 'bee-restore-'));
after(() => rmSync(temp, { recursive: true, force: true }));

/** A small ustar archive */
function tar(entries: [string, string][]): Buffer {
    const blocks: Buffer[] = [];
    for (const [name, content] of entries) {
        const data = Buffer.from(content);
        const h = Buffer.alloc(512);
        h.write(name, 0, 'utf8');
        h.write('0000644\0', 100);
        h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
        h.write('        ', 148);
        h.write('0', 156);
        h.write('ustar\0', 257);
        let sum = 0;
        for (const b of h) {
            sum += b;
        }
        h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
        blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const LINUX: RestoreFacts = { platform: 'linux', service: 'iobroker.service', sudo: true };

function request(over: Partial<RestoreRequest> = {}): RestoreRequest {
    return {
        id: 'bak_abc',
        key: randomBytes(32).toString('base64'),
        url: 'https://s3.example.com/fleet/t1/a/bak_abc.bee?X-Amz-Signature=x',
        size: 1000,
        sha256: 'a'.repeat(64),
        ts: Date.now() - 3600_000,
        jsController: '7.0.7',
        expiresAt: Date.now() + 3600_000,
        ...over,
    };
}

describe('restore: checks before', () => {
    it('refuses what cannot work, with the reason', () => {
        assert.equal(restoreRefusal(request(), LINUX, '7.0.7', 1), null);
        assert.equal(restoreRefusal(request({ jsController: '7.0.6' }), LINUX, '7.0.7', 1), null, 'older: --force');
        assert.match(restoreRefusal(request({ jsController: '7.1.0' }), LINUX, '7.0.7', 1)!, /erst js-controller aktualisieren/);
        assert.match(restoreRefusal(request(), { ...LINUX, platform: 'win32' }, '7.0.7', 1)!, /nur unter Linux/);
        assert.match(restoreRefusal(request(), { ...LINUX, service: null }, '7.0.7', 1)!, /systemd-Dienst/);
        assert.match(restoreRefusal(request(), { ...LINUX, sudo: false }, '7.0.7', 1)!, /sudo/);
        assert.match(restoreRefusal(request(), LINUX, '7.0.7', 2)!, /2 Hosts/);
        for (const bad of [
            { id: '../x' },
            { key: randomBytes(16).toString('base64') },
            { url: 'http://s3.example.com/x' },
            { sha256: 'xyz' },
            { size: 10 },
            { expiresAt: Date.now() - 1 },
        ]) {
            assert.equal(restoreRefusal(request(bad), LINUX, '7.0.7', 1), 'Unvollständige oder ungültige Anfrage', JSON.stringify(bad));
        }
        assert.equal(restoreRefusal(undefined, LINUX, '7.0.7', 1), 'Unvollständige oder ungültige Anfrage');
    });

    it('needs room for the file, the archive and the backup of now', () => {
        assert.equal(spaceNeeded(100 * 1024 * 1024), 500 * 1024 * 1024);
    });

    it('compares settings whatever the order of their keys', () => {
        assert.ok(sameSettings({ a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 }));
        assert.ok(!sameSettings({ enrollToken: 't1.new', a: 1 }, { enrollToken: 't1.old', a: 1 }));
    });
});

describe('restore: the file of the storage', () => {
    it('decrypts what the device encrypted, and nothing that does not pass', async () => {
        const plain = join(temp, 'plain.tar.gz');
        const content = randomBytes(200_000);
        writeFileSync(plain, content);
        const key = randomBytes(32);
        const enc = join(temp, 'bak_one.bee');
        await encryptBackup(plain, enc, key, 'bak_one');
        const out = join(temp, 'out.tar.gz');
        await decryptBackup(enc, out, key, 'bak_one');
        assert.deepEqual(readFileSync(out), content);

        // another id: the file of another backup
        rmSync(out);
        await assert.rejects(decryptBackup(enc, out, key, 'bak_two'), /Entschlüsseln fehlgeschlagen/);
        assert.equal(existsSync(out), false);
        await assert.rejects(decryptBackup(enc, out, randomBytes(32), 'bak_one'), /Entschlüsseln fehlgeschlagen/);
        const broken = Buffer.from(readFileSync(enc));
        broken[5000] ^= 1;
        writeFileSync(enc, broken);
        await assert.rejects(decryptBackup(enc, out, key, 'bak_one'), /Entschlüsseln fehlgeschlagen/);
        writeFileSync(enc, Buffer.concat([Buffer.from('NOTABAK1'), randomBytes(100)]));
        await assert.rejects(decryptBackup(enc, out, key, 'bak_one'), /keine Flottensicherung/);
    });

    it('finds the instance of the agent in the archive', async () => {
        const file = join(temp, 'with.tar.gz');
        const objects = [
            { _id: 'system.config', type: 'config' },
            { _id: 'system.adapter.bee.0', type: 'instance', common: { name: 'bee' } },
            { _id: 'bee.0.info.connection', type: 'state', common: { desc: 'system.adapter.bee.1' } },
        ];
        writeFileSync(
            file,
            gzipSync(tar([['backup/objects.jsonl', objects.map(o => JSON.stringify(o)).join('\n') + '\n']])),
        );
        assert.equal(await archiveHasObject(file, 'system.adapter.bee.0'), true);
        assert.equal(await archiveHasObject(file, 'system.adapter.bee.1'), false, 'only as text in another object');
        const legacy = join(temp, 'legacy.tar.gz');
        writeFileSync(legacy, gzipSync(tar([['backup/backup.json', '{"objects":[]}']])));
        assert.equal(await archiveHasObject(legacy, 'system.adapter.bee.0'), null);
    });
});

describe('restore: download', () => {
    const body = randomBytes(300_000);
    let server: Server;
    let port = 0;
    /** what the next requests do: cut after n bytes, ignore the range, refuse */
    const plan: ('cut' | 'full' | 'ok' | 'forbidden')[] = [];
    const ranges: string[] = [];

    const start = async (): Promise<void> => {
        server = createServer((req, res) => {
            ranges.push(String(req.headers.range ?? ''));
            const what = plan.shift() ?? 'ok';
            if (what === 'forbidden') {
                res.writeHead(403);
                res.end('<Error><Code>AccessDenied</Code></Error>');
                return;
            }
            const from = what !== 'full' && req.headers.range ? Number(/bytes=(\d+)-/.exec(req.headers.range)![1]) : 0;
            const part = body.subarray(from);
            res.writeHead(from ? 206 : 200, { 'Content-Length': part.length });
            if (what === 'cut') {
                res.write(part.subarray(0, 100_000));
                setTimeout(() => res.destroy(), 20);
                return;
            }
            res.end(part);
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        port = (server.address() as { port: number }).port;
    };
    after(() => server?.close());

    const req = (): Pick<RestoreRequest, 'url' | 'size' | 'sha256' | 'expiresAt'> => ({
        url: `http://127.0.0.1:${port}/bak.bee`,
        size: body.length,
        sha256: sha(body),
        expiresAt: Date.now() + 60_000,
    });

    it('goes on where a broken connection stood, and checks the file', async () => {
        await start();
        const file = join(temp, 'dl1.bee');
        plan.push('cut', 'ok');
        ranges.length = 0;
        const seen: number[] = [];
        await downloadBackup(file, req(), { delays: [10], onProgress: d => seen.push(d) });
        assert.deepEqual(readFileSync(file), body);
        assert.equal(ranges[0], '');
        assert.match(ranges[1], /^bytes=\d+-$/);
        assert.equal(seen.at(-1), body.length);
    });

    it('starts again when the storage ignores the range', async () => {
        const file = join(temp, 'dl2.bee');
        plan.push('cut', 'full');
        await downloadBackup(file, req(), { delays: [10] });
        assert.deepEqual(readFileSync(file), body);
    });

    it('gives up on a refused address, and on a file that is not the backup', async () => {
        const file = join(temp, 'dl3.bee');
        plan.push('forbidden');
        await assert.rejects(downloadBackup(file, req(), { delays: [10] }), /403 AccessDenied/);
        await assert.rejects(downloadBackup(file, { ...req(), sha256: 'b'.repeat(64) }, { delays: [10] }), /SHA-256/);
        assert.equal(existsSync(file), false);
    });
});

describe('restore: script', { skip: process.platform !== 'linux' && !process.env.BEE_TEST_BASH }, () => {
    const script = join(__dirname, '..', 'scripts', 'restore.sh');

    /**
     * Runs restore.sh with a fake systemctl and a fake js-controller: `restore` uninstalls the agent (as
     * `iobroker restore` does), changes package.json and writes iobroker.json of the archive
     */
    function run(o: { verdict?: string; fail?: string[]; wait?: number; force?: boolean }): {
        status: { state: string; detail: string };
        calls: string[];
        dir: string;
        iob: string;
    } {
        const root = mkdtempSync(join(temp, 'script-'));
        const bin = join(root, 'bin');
        const state = join(root, 'state');
        const data = join(root, 'data');
        const iob = join(root, 'iobroker');
        for (const d of [bin, state, data, iob, join(iob, 'iobroker-data'), join(iob, 'node_modules', 'iobroker.js-controller'), join(iob, 'node_modules', 'iobroker.bee')]) {
            mkdirSync(d, { recursive: true });
        }
        writeFileSync(join(iob, 'node_modules', 'iobroker.bee', 'main.js'), 'agent 0.8.0');
        writeFileSync(join(iob, 'node_modules', 'iobroker.js-controller', 'iobroker.js'), '');
        writeFileSync(join(iob, 'package.json'), '{"dependencies":{"iobroker.bee":"0.8.0"}}');
        writeFileSync(join(iob, 'iobroker-data', 'iobroker.json'), '{"device":"new"}');
        const archive = join(data, 'bak.tar.gz');
        const rollback = join(root, 'before.tar.gz');
        writeFileSync(archive, '{"device":"old"}');
        writeFileSync(rollback, '{"device":"new"}');
        writeFileSync(join(state, 'calls'), '');
        if (o.verdict) {
            writeFileSync(join(state, 'verdict'), o.verdict);
        }
        for (const f of o.fail ?? []) {
            writeFileSync(join(state, `fail-${f}`), '');
        }
        const stubs: Record<string, string> = {
            chown: 'true',
            systemctl: [
                'echo "systemctl $*" >> "$STATE/calls"',
                'if [ "$1" = start ] && [ -f "$STATE/verdict" ] && [ ! -f "$STATE/started" ]; then',
                '  touch "$STATE/started"; cp "$STATE/verdict" "$DATA/restore-verdict.json"',
                'fi',
            ].join('\n'),
            node: [
                'shift',
                'echo "cli $* in $(pwd)" >> "$STATE/calls"',
                '[ "$1" = restore ] || exit 0',
                'name=$(basename "$2" .tar.gz)',
                '[ -f "$STATE/fail-$name" ] && exit 7',
                // as iobroker restore: the adapters are uninstalled, iobroker.json comes from the archive
                'rm -rf node_modules/iobroker.bee',
                'echo "{}" > package.json',
                'cp "$2" iobroker-data/iobroker.json',
            ].join('\n'),
        };
        for (const [name, body] of Object.entries(stubs)) {
            writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
            chmodSync(join(bin, name), 0o755);
        }
        const user = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
        const r = spawnSync(
            'bash',
            [script, data, iob, archive, rollback, 'iobroker.service', String(o.wait ?? 0), o.force ? '1' : '0', user, join(bin, 'node')],
            {
                env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, STATE: state, DATA: data },
                encoding: 'utf8',
                timeout: 30_000,
            },
        );
        assert.equal(r.error, undefined);
        return {
            status: JSON.parse(readFileSync(join(data, 'restore-status.json'), 'utf8')),
            calls: readFileSync(join(state, 'calls'), 'utf8').trim().split('\n'),
            dir: data,
            iob,
        };
    }

    const agentThere = (iob: string): string => readFileSync(join(iob, 'node_modules', 'iobroker.bee', 'main.js'), 'utf8');
    const config = (iob: string): string => readFileSync(join(iob, 'iobroker-data', 'iobroker.json'), 'utf8').trim();

    it('plays the backup in, keeps the installed software and stays with a positive verdict', () => {
        const r = run({ verdict: '{"ok":true}\n', wait: 5, force: true });
        assert.equal(r.status.state, 'ok', JSON.stringify(r));
        assert.deepEqual(
            r.calls.map(c => c.replace(/ in .*$/, '').replace(/\S*bak\.tar\.gz/, 'ARCHIVE')),
            ['systemctl stop iobroker.service', `cli restore ARCHIVE --force`, 'systemctl start iobroker.service'],
        );
        assert.equal(agentThere(r.iob), 'agent 0.8.0', 'the agent is back');
        assert.match(readFileSync(join(r.iob, 'package.json'), 'utf8'), /iobroker\.bee/);
        assert.equal(config(r.iob), '{"device":"old"}', 'the configuration of the backup');
        assert.equal(existsSync(join(r.iob, 'node_modules.bee-restore')), false);
    });

    it('goes back to the state before on a negative verdict', () => {
        const r = run({ verdict: '{"ok":false,"reason":"Einstellungen nicht zurück"}\n', wait: 5 });
        assert.equal(r.status.state, 'restored');
        assert.equal(r.status.detail, 'Einstellungen nicht zurück');
        assert.ok(r.calls.some(c => /cli restore \S*before\.tar\.gz$/.test(c.replace(/ in .*$/, ''))), r.calls.join('\n'));
        assert.equal(config(r.iob), '{"device":"new"}');
        assert.equal(agentThere(r.iob), 'agent 0.8.0');
    });

    it('goes back without an answer of the agent', () => {
        const r = run({ wait: 0 });
        assert.equal(r.status.state, 'restored');
        assert.match(r.status.detail, /Keine Rückmeldung/);
    });

    it('goes back when iobroker restore fails, with iobroker.json from before', () => {
        const r = run({ fail: ['bak'] });
        assert.equal(r.status.state, 'restored');
        assert.match(r.status.detail, /Exit-Code 7/);
        assert.equal(config(r.iob), '{"device":"new"}');
        assert.equal(agentThere(r.iob), 'agent 0.8.0');
    });

    it('reports failed when the state before does not come back either, with the software in place', () => {
        const r = run({ fail: ['bak', 'before'] });
        assert.equal(r.status.state, 'failed');
        assert.match(r.status.detail, /ließ sich nicht einspielen/);
        assert.equal(agentThere(r.iob), 'agent 0.8.0');
        assert.equal(config(r.iob), '{"device":"new"}');
        assert.equal(r.calls.at(-1), 'systemctl start iobroker.service');
    });
});
