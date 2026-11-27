import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
    adaptersFromInstalled,
    collectHosts,
    hostCommands,
    HostExec,
    logFileData,
    remoteLogFiles,
    type HostSource,
} from '../src/lib/hosts';
import { packageVersion } from '../src/lib/inventory';
import type { HostInventory, JobStep } from '../src/lib/protocol';
import { softwareRefusal, type SoftwareContext } from '../src/lib/softwareCommand';
import { executeStep, type StepHost } from '../src/lib/steps';
import { nodeTimers } from './timers';

describe('CLI on another host (cmdExec)', () => {
    it('collects the output until cmdExit and ignores the repeated exit', async () => {
        const sent: { host: string; command: string; message: { id: string; data: string } }[] = [];
        const exec = new HostExec(
            (host, command, message) => sent.push({ host, command, message: message as never }),
            nodeTimers,
        );
        const done = exec.run('frigate', ['upgrade', 'frigate@3.3.0', '--yes']);
        assert.equal(sent[0].host, 'system.host.frigate');
        assert.equal(sent[0].command, 'cmdExec');
        assert.equal(sent[0].message.data, 'upgrade frigate@3.3.0 --yes');
        const id = sent[0].message.id;
        assert.equal(exec.onMessage({ command: 'cmdStdout', message: { id, data: 'upgrade frigate' } }), true);
        assert.equal(exec.onMessage({ command: 'cmdStderr', message: { id, data: 'npm warn' } }), true);
        assert.equal(exec.onMessage({ command: 'cmdExit', message: { id, data: 0 } }), true);
        // js-controller sends the exit again after a second
        assert.equal(exec.onMessage({ command: 'cmdExit', message: { id, data: 0 } }), true);
        assert.equal(exec.onMessage({ command: 'other', message: {} }), false);
        const result = await done;
        assert.equal(result.code, 0);
        assert.match(result.output, /upgrade frigate\nnpm warn/);
    });

    it('refuses arguments with spaces: js-controller splits at them', async () => {
        const exec = new HostExec(() => assert.fail('nothing to send'), nodeTimers);
        assert.equal((await exec.run('frigate', ['url', 'a b'])).code, 1);
    });

    it('gives up after the timeout and when the agent stops', async () => {
        const exec = new HostExec(() => {}, nodeTimers);
        assert.equal((await exec.run('frigate', ['list'], undefined, 10)).code, 1);
        const pending = exec.run('frigate', ['list']);
        exec.stop();
        assert.match((await pending).output, /beendet/);
    });

    it('runs a step there and checks the version the host reports afterwards', async () => {
        let version: string | null = '3.2.6';
        const calls: string[] = [];
        const host: StepHost = {
            run: args => {
                calls.push(args.join(' '));
                if (args[0] === 'upgrade') {
                    version = '3.3.0';
                }
                return Promise.resolve({ code: 0, output: '' });
            },
            installed: () => Promise.resolve(version),
            note: () => {},
        };
        const step: JobStep = { action: 'upgrade', adapter: 'frigate', from: '3.2.6', to: '3.3.0', status: 'pending' };
        const r = await executeStep(step, host);
        assert.deepEqual(calls, ['upgrade frigate@3.3.0 --yes']);
        assert.equal(r.mismatch, null);
    });

    it('reports when the version did not change, as on vitanova', async () => {
        const host: StepHost = {
            run: () => Promise.resolve({ code: 0, output: 'Adapter "frigate"        is not installed.' }),
            installed: () => Promise.resolve(null),
            note: () => {},
        };
        const step: JobStep = { action: 'upgrade', adapter: 'frigate', from: '3.2.6', to: '3.3.0', status: 'pending' };
        assert.equal((await executeStep(step, host)).mismatch, 'installiert ist nichts statt 3.3.0');
    });
});

describe('inventory of the other hosts', () => {
    it('takes the adapters with their package on the host, without js-controller', () => {
        const answer = {
            'js-controller': { controller: true, version: '8.0.0' },
            frigate: { version: '3.2.6' },
            history: { version: '4.0.0' },
            broken: { title: 'no version' },
            hosts: { frigate: { version: '8.0.0' } },
        };
        assert.deepEqual(adaptersFromInstalled(answer, { frigate: 'iobroker.frigate@3.2.6' }), {
            frigate: { version: '3.2.6', installedFrom: 'iobroker.frigate@3.2.6' },
            history: { version: '4.0.0' },
        });
        assert.equal(adaptersFromInstalled(undefined), undefined);
    });

    it('knows what works on a host', () => {
        assert.deepEqual(hostCommands('8.0.0', 'linux'), [
            'instance',
            'restart',
            'osUpgrade',
            'controller',
            'logs',
            'adapter',
            'software',
        ]);
        assert.deepEqual(hostCommands('5.0.19', 'linux'), ['instance', 'restart', 'controller', 'logs', 'adapter', 'software']);
        assert.ok(!hostCommands('4.0.24', 'linux').includes('controller'));
        assert.ok(!hostCommands('8.0.0', 'win32').includes('controller'));
        assert.ok(!hostCommands('8.0.0', 'win32').includes('osUpgrade'));
    });

    function source(alive: boolean, answers: Record<string, unknown>): HostSource {
        return {
            own: 'vitanova',
            hostObjects: () =>
                Promise.resolve([
                    { _id: 'system.host.vitanova', type: 'host', common: { installedVersion: '8.0.0' }, native: {} },
                    {
                        _id: 'system.host.frigate',
                        type: 'host',
                        common: { installedVersion: '8.0.0' },
                        native: { os: { release: '6.1.0' } },
                    },
                ] as unknown as ioBroker.Object[]),
            alive: () => Promise.resolve(alive),
            send: (_host, command) => Promise.resolve(answers[command]),
            instances: () =>
                Promise.resolve([
                    { _id: 'system.adapter.frigate.0', common: { host: 'frigate', name: 'frigate' } },
                    { _id: 'system.adapter.admin.0', common: { host: 'vitanova', name: 'admin' } },
                ] as unknown as ioBroker.InstanceObject[]),
            describe: () => Promise.resolve({ enabled: true, alive, mode: 'daemon' }),
            installedFrom: () => Promise.resolve({}),
            osUpdates: () => Promise.resolve(undefined),
        };
    }

    it('lists every host but the own one, with its adapters and instances', async () => {
        const known = new Map<string, HostInventory>();
        const hosts = await collectHosts(
            source(true, {
                getHostInfo: { os: 'linux', Platform: 'linux', Architecture: 'x64', 'Node.js': 'v22.12.0', NPM: '10.9.0', RAM: 8e9 },
                getInstalled: { 'js-controller': { controller: true, version: '8.0.0' }, frigate: { version: '3.2.6' } },
            }),
            known,
        );
        assert.equal(hosts.length, 1);
        const h = hosts[0];
        assert.equal(h.name, 'frigate');
        assert.equal(h.alive, true);
        assert.equal(h.node, 'v22.12.0');
        assert.equal(h.system?.kernel, '6.1.0');
        assert.deepEqual(h.adapters, { frigate: { version: '3.2.6' } });
        assert.deepEqual(Object.keys(h.instances), ['frigate.0']);
        assert.ok(h.commands.includes('osUpgrade'));
    });

    it('keeps what an offline host answered last', async () => {
        const known = new Map<string, HostInventory>();
        await collectHosts(
            source(true, { getHostInfo: { os: 'linux', 'Node.js': 'v22.12.0' }, getInstalled: { frigate: { version: '3.2.6' } } }),
            known,
        );
        const [h] = await collectHosts(source(false, {}), known);
        assert.equal(h.alive, false);
        assert.equal(h.node, 'v22.12.0');
        assert.deepEqual(h.adapters, { frigate: { version: '3.2.6' } });
    });

    it('leaves the adapters out when a host never answered', async () => {
        const [h] = await collectHosts(source(false, {}), new Map());
        assert.equal(h.adapters, undefined);
    });
});

describe('adapters of the own host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bee-hosts-'));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('counts only a package on this host, not the object of an adapter on another host', () => {
        mkdirSync(join(dir, 'iobroker.admin'));
        writeFileSync(join(dir, 'iobroker.admin', 'package.json'), JSON.stringify({ version: '8.3.11' }));
        assert.equal(packageVersion(dir, 'admin'), '8.3.11');
        assert.equal(packageVersion(dir, 'frigate'), null);
    });
});

describe('log files of another host', () => {
    it('reads the list of getLogFiles with the transport and the date of the name', () => {
        const files = remoteLogFiles(
            {
                list: [
                    { fileName: 'log/frigate/file1/iobroker.2026-11-10.log', size: 100 },
                    { fileName: 'log/frigate/file1/iobroker.2026-11-11.log.gz', size: 50 },
                    { fileName: 'log/other/file1/iobroker.2026-11-12.log', size: 1 },
                    { fileName: 'log/frigate/file1/../etc/passwd', size: 1 },
                ],
            },
            'frigate',
        );
        assert.deepEqual(
            files.map(f => [f.name, f.transport, f.size]),
            [
                ['iobroker.2026-11-11.log.gz', 'file1', 50],
                ['iobroker.2026-11-10.log', 'file1', 100],
            ],
        );
    });

    it('takes the content as Buffer, also after JSON', () => {
        assert.equal(logFileData({ data: Buffer.from('abc') }).toString(), 'abc');
        assert.equal(logFileData({ data: { type: 'Buffer', data: [97, 98] } }).toString(), 'ab');
        assert.throws(() => logFileData({ error: 'Cannot find file' }), /Cannot find file/);
    });
});

describe('software on several hosts', () => {
    const ctx = (over: Partial<SoftwareContext>): SoftwareContext => ({
        own: 'bee.0',
        host: 'frigate',
        desired: null,
        adapterObj: { type: 'adapter', common: { name: 'frigate' } } as unknown as ioBroker.Object,
        instances: [],
        ...over,
    });

    it('refuses an adapter not installed on the host of the command', () => {
        assert.match(
            softwareRefusal({ action: 'addInstance', adapter: 'frigate' }, ctx({ host: 'vitanova', installedOn: ['frigate'] }))!,
            /auf dem Host vitanova nicht installiert \(nur auf frigate\)/,
        );
    });

    it('does not remove an adapter installed on another host too: del removes the object of the system', () => {
        assert.match(
            softwareRefusal({ action: 'removeAdapter', adapter: 'frigate' }, ctx({ installedOn: ['frigate', 'vitanova'] }))!,
            /auch auf vitanova installiert/,
        );
        assert.equal(
            softwareRefusal({ action: 'removeAdapter', adapter: 'frigate' }, ctx({ installedOn: ['frigate'] })),
            null,
        );
    });
});
