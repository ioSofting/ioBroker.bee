import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ensurePackage, packageFile, packagesOf, trustedPackageUrl } from '../src/lib/packages';
import { computePlan } from '../src/lib/planner';
import type { DesiredMessage, ProfileAdapter } from '../src/lib/protocol';
import { cliArgs } from '../src/runner';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function desired(adapters: Record<string, ProfileAdapter>): DesiredMessage {
    return {
        v: 1,
        ts: 0,
        assetId: 'ast_1',
        mode: 'managed',
        profile: { id: 'prf_1', name: 'womo + 1 je Anlage', hash: 'abc', jsController: '7.0.7', node: '22', adapters },
        tolerated: [],
        remove: [],
        retry: 0,
    };
}

describe('packages of the fleet server', () => {
    const data = Buffer.from('not really a tgz, only bytes to check');
    const good = sha(data);
    let server: http.Server;
    let base = '';
    let dir = '';
    let requests = 0;

    before(async () => {
        dir = mkdtempSync(join(tmpdir(), 'bee-pkg-'));
        server = http.createServer((req, res) => {
            requests++;
            if (req.url === `/api/device/packages/dev/tok/${good}.tgz`) {
                res.end(data);
            } else if (req.url?.startsWith('/big/')) {
                res.end(Buffer.alloc(data.length + 10));
            } else {
                res.statusCode = 404;
                res.end();
            }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://localhost:${(server.address() as AddressInfo).port}`;
    });

    after(() => {
        server.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('loads only from its own server', () => {
        const servers = ['https://bee.example.com', 'mqtts://bee.example.com:8883'];
        assert.equal(trustedPackageUrl('https://bee.example.com/api/device/packages/a/b/c.tgz', servers), true);
        assert.equal(trustedPackageUrl('https://evil.example.com/x.tgz', servers), false);
        assert.equal(
            trustedPackageUrl('http://bee.example.com/x.tgz', servers),
            false,
            'no plain text over the internet',
        );
        assert.equal(trustedPackageUrl('file:///etc/passwd', servers), false);
        assert.equal(trustedPackageUrl('http://localhost:8091/x.tgz', ['http://localhost:8091']), true);
    });

    it('takes the packages of the planned steps', () => {
        const tarball = { url: 'https://bee.example.com/p.tgz', sha256: good, size: 1 };
        const d = desired({ flow: { version: '0.0.4', tarball }, admin: { version: '7.7.2' } });
        const plan = computePlan(d, { admin: '7.6.17' });
        assert.deepEqual(packagesOf(d, plan), { flow: tarball });
    });

    it('downloads, checks the SHA-256 and keeps the file', async () => {
        const url = `${base}/api/device/packages/dev/tok/${good}.tgz`;
        const opts = { serverUrls: [base], ca: [] };
        const file = await ensurePackage(dir, { url, sha256: good, size: data.length }, opts);
        assert.equal(file, packageFile(dir, good));
        assert.deepEqual(readFileSync(file), data);
        const before = requests;
        await ensurePackage(dir, { url, sha256: good, size: data.length }, opts);
        assert.equal(requests, before, 'already here: not loaded again');

        const other = 'a'.repeat(64);
        await assert.rejects(
            ensurePackage(dir, { url, sha256: other, size: data.length }, opts),
            /Prüfsumme stimmt nicht/,
        );
        await assert.rejects(
            ensurePackage(dir, { url: `${base}/big/${other}.tgz`, sha256: other, size: data.length }, opts),
            /größer als angekündigt/,
        );
        await assert.rejects(
            ensurePackage(dir, { url: 'https://evil.example.com/x.tgz', sha256: other, size: 1 }, opts),
            /gehört nicht zum Flottenserver/,
        );
        await assert.rejects(ensurePackage(dir, { url, sha256: '../x', size: 1 }, opts), /ungültige Prüfsumme/);
        // a damaged file is replaced
        writeFileSync(packageFile(dir, good), 'broken');
        await ensurePackage(dir, { url, sha256: good, size: data.length }, opts);
        assert.deepEqual(readFileSync(packageFile(dir, good)), data);
    });

    it('installs from the file with the CLI, the name given', () => {
        const step = { adapter: 'flow', from: null, to: '0.0.4', status: 'pending' as const };
        assert.deepEqual(cliArgs({ ...step, action: 'install' }, '/data/p.tgz'), [
            ['url', '/data/p.tgz', 'flow'],
            ['add', 'flow'],
        ]);
        assert.deepEqual(cliArgs({ ...step, action: 'upgrade', from: '0.0.3' }, '/data/p.tgz'), [
            ['url', '/data/p.tgz', 'flow'],
        ]);
        assert.deepEqual(cliArgs({ ...step, action: 'install' }), [['add', 'flow@0.0.4']]);
        assert.deepEqual(cliArgs({ ...step, action: 'remove', to: null }, '/data/p.tgz'), [['del', 'flow']]);
    });

    it('installs a package with the installed version number once, if it came from somewhere else', () => {
        const tarball = { url: 'https://bee.example.com/p.tgz', sha256: good, size: 1 };
        const d = desired({ flow: { version: '0.0.4', tarball } });
        const plan = computePlan(d, { flow: '0.0.4' }, 'bee', { flow: 'iobroker.flow@0.0.4' });
        assert.deepEqual(
            plan.map(s => `${s.action} ${s.adapter} ${s.from} ${s.to}`),
            ['upgrade flow 0.0.4 0.0.4'],
        );
        assert.deepEqual(computePlan(d, { flow: '0.0.4' }, 'bee', { flow: `/data/packages/${good}.tgz` }), []);
        assert.deepEqual(computePlan(d, { flow: '0.0.4' }, 'bee'), [], 'without the source: nothing');
        assert.deepEqual(computePlan(d, { flow: '0.0.4' }, 'bee', {}), [], 'source unknown: nothing');
    });
});
