import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { JobStep } from '../src/lib/protocol';
import { npmArgs, runStep, type RunnerFile } from '../src/runner';

/** The CLI of js-controller as far as the runner needs it: admin is in the repository, everything else only on npm */
const FAKE_CLI = `
const fs = require('node:fs');
const path = require('node:path');
const [cmd, spec, name] = process.argv.slice(2);
const install = (adapter, version) => {
    const dir = path.join(process.cwd(), 'node_modules', 'iobroker.' + adapter);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
};
const [adapter, version] = (spec || '').split('@');
// "add <name>" without version creates the instance of an adapter installed already
const instanceOnly = cmd === 'add' && !version && fs.existsSync(path.join(process.cwd(), 'node_modules', 'iobroker.' + adapter));
if (instanceOnly) {
    console.log('add instance ' + adapter);
} else if (cmd === 'upgrade' || cmd === 'add') {
    if (adapter !== 'admin') {
        console.log(cmd === 'add'
            ? 'host.test Unknown packet name ' + adapter + '. Please install packages from outside the repository using npm!'
            : 'Adapter "' + adapter + '" is not in the repository and cannot be updated.');
        process.exit(cmd === 'add' ? 51 : 10);
    }
    install(adapter, version);
} else if (cmd === 'url') {
    install(name, spec.split('@')[1]);
    console.log('install ' + spec);
} else {
    process.exit(1);
}
`;

describe('runner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bee-runner-'));
    const cli = join(dir, 'iobroker.js');
    writeFileSync(cli, FAKE_CLI);
    const file: RunnerFile = {
        mode: 'apply',
        steps: [],
        iobroker: cli,
        cwd: dir,
        haltFile: join(dir, 'halt'),
        logFile: join(dir, 'runner.log'),
        phase: 'running',
    };
    const step = (action: JobStep['action'], adapter: string, to: string): JobStep => ({
        action,
        adapter,
        from: action === 'install' ? null : '0.0.1',
        to,
        status: 'pending',
    });
    const calls = (): string[] =>
        readFileSync(file.logFile, 'utf8')
            .split('\n')
            .filter(l => l.includes('] iobroker '))
            .map(l => l.replace(/^\[[^\]]+\] iobroker /, ''));

    after(() => rmSync(dir, { recursive: true, force: true }));

    it('knows the calls from npm for an adapter outside the repositories', () => {
        assert.deepEqual(npmArgs(step('upgrade', 'bee', '0.2.9')), [['url', 'iobroker.bee@0.2.9', 'bee']]);
        assert.deepEqual(npmArgs(step('install', 'eigen', '1.0.0')), [
            ['url', 'iobroker.eigen@1.0.0', 'eigen'],
            ['add', 'eigen'],
        ]);
        assert.equal(npmArgs({ action: 'remove', adapter: 'x', from: '1.0.0', to: null, status: 'pending' }), null);
    });

    it('updates an adapter of the repository with the CLI as before', async () => {
        const res = await runStep(file, step('upgrade', 'admin', '7.7.2'));
        assert.equal(res.code, 0);
        assert.deepEqual(calls(), ['upgrade admin@7.7.2 --yes']);
    });

    it('installs and updates an adapter that is not in the repository from npm, like admin', async () => {
        writeFileSync(file.logFile, '');
        const up = await runStep(file, step('upgrade', 'bee', '0.2.9'));
        assert.equal(up.code, 0, up.output);
        const down = await runStep(file, step('downgrade', 'bee', '0.2.8'));
        assert.equal(down.code, 0, down.output);
        const added = await runStep(file, step('install', 'eigen', '1.0.0'));
        assert.equal(added.code, 0, added.output);
        assert.deepEqual(calls(), [
            'upgrade bee@0.2.9 --yes',
            'url iobroker.bee@0.2.9 bee',
            'upgrade bee@0.2.8 --yes --force',
            'url iobroker.bee@0.2.8 bee',
            'add eigen@1.0.0',
            'url iobroker.eigen@1.0.0 eigen',
            'add eigen',
        ]);
        assert.match(readFileSync(file.logFile, 'utf8'), /\[npm\] bee is not in the repositories/);
    });

    it('takes a package of the server as it is', async () => {
        writeFileSync(file.logFile, '');
        const res = await runStep({ ...file, files: { bee: '/data/bee.tgz' } }, step('upgrade', 'bee', '0.3.0'));
        assert.equal(res.code, 0, res.output);
        assert.deepEqual(calls(), ['url /data/bee.tgz bee']);
    });
});
