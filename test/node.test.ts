import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { JobManager, type JobDeps, type JobFile } from '../src/lib/jobs';
import { engineConflicts, majorOf, nodeBlockers, nodeStep, serviceOf, type NodeFacts } from '../src/lib/node';
import { checkDependencies, computePlan, rollbackPlan } from '../src/lib/planner';
import { preflight } from '../src/lib/preflight';
import type { DesiredMessage, JobStep } from '../src/lib/protocol';
import { cliArgs } from '../src/runner';

const temp = mkdtempSync(join(tmpdir(), 'bee-node-'));
after(() => rmSync(temp, { recursive: true, force: true }));

const desired = (node: string, adapters: Record<string, { version: string; node?: string }> = {}): DesiredMessage => ({
    v: 1,
    ts: 1,
    assetId: 'a',
    mode: 'managed',
    profile: { id: 'p', name: 'P', hash: 'h', jsController: '7.0.0', node, adapters },
    tolerated: [],
    remove: [],
    retry: 0,
});

const facts: NodeFacts = {
    platform: 'linux',
    service: 'iobroker.service',
    sudo: true,
    arch: 'arm64',
    packaged: true,
    source: true,
    held: false,
    offDeviceBackup: true,
};

describe('node: plan', () => {
    it('plans Node.js only upwards, first of all steps', () => {
        assert.equal(majorOf('v22.11.0'), 22);
        assert.equal(majorOf('22.x'), 22);
        assert.equal(majorOf(''), null);
        assert.deepEqual(nodeStep('22', 'v20.18.0'), { action: 'node', from: 'v20.18.0', to: '22', status: 'pending' });
        assert.equal(nodeStep('22', 'v22.1.0'), null);
        assert.equal(nodeStep('20', 'v22.1.0'), null, 'no downgrade');
        assert.equal(nodeStep('', 'v20.1.0'), null);

        const d = desired('22', { bee: { version: '0.3.0' }, javascript: { version: '9.0.0' } });
        const plan = computePlan(d, { bee: '0.2.0', javascript: '8.0.0' }, 'bee', undefined, 'v20.18.0');
        assert.deepEqual(
            plan.map(s => `${s.action} ${s.adapter ?? s.to}`),
            ['node 22', 'upgrade javascript', 'upgrade bee'],
        );
        assert.deepEqual(computePlan(d, { bee: '0.3.0', javascript: '9.0.0' }, 'bee', undefined, 'v22.3.0'), []);
        assert.deepEqual(computePlan(d, { bee: '0.3.0', javascript: '9.0.0' }, 'bee'), [], 'without the version');
    });

    it('a rollback keeps Node.js', () => {
        const steps: JobStep[] = [
            { action: 'backup', status: 'ok' },
            { action: 'node', from: 'v20.18.0', to: '22', status: 'ok' },
            { action: 'upgrade', adapter: 'javascript', from: '8.0.0', to: '9.0.0', status: 'ok' },
        ];
        assert.deepEqual(
            rollbackPlan(steps).map(s => `${s.action} ${s.adapter}`),
            ['downgrade javascript'],
        );
        assert.deepEqual(cliArgs(steps[1]), []);
    });

    it('checks engines.node of new versions against the planned line', () => {
        const d = desired('22', { javascript: { version: '9.0.0', node: '>=22' } });
        const env = { jsController: '7.0.0', node: 'v20.18.0' };
        assert.match(checkDependencies(d, {}, env)[0], /installiert ist v20\.18\.0/);
        assert.deepEqual(checkDependencies(d, {}, { ...env, nodeMajor: 22 }), []);
        const old = desired('22', { javascript: { version: '9.0.0', node: '<21' } });
        assert.match(checkDependencies(old, {}, { ...env, nodeMajor: 22 })[0], /geplant ist Node 22/);
    });
});

describe('node: preconditions', () => {
    it('finds the systemd service in /proc/self/cgroup', () => {
        assert.equal(serviceOf('0::/system.slice/iobroker.service\n'), 'iobroker.service');
        assert.equal(serviceOf('12:cpuset:/\n1:name=systemd:/system.slice/iobroker.service\n'), 'iobroker.service');
        assert.equal(serviceOf('0::/user.slice/user-1000.slice/session-3.scope\n'), null);
        assert.equal(serviceOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/x.service'), null);
        assert.equal(serviceOf(''), null);
    });

    it('blocks with a reason for everything missing', () => {
        assert.deepEqual(nodeBlockers(facts), []);
        assert.deepEqual(nodeBlockers({ ...facts, platform: 'win32' }), ['nur unter Linux möglich']);
        const all = nodeBlockers({
            ...facts,
            service: null,
            sudo: false,
            arch: 'armhf',
            held: true,
            offDeviceBackup: false,
        });
        assert.equal(all.length, 5);
        assert.match(all.join('; '), /systemd-Dienst.*sudo.*armhf.*hold.*Sicherung/);
        assert.match(nodeBlockers({ ...facts, packaged: false }).join(), /nicht aus dem Paket nodejs/);
    });

    it('finds installed packages that exclude the line', () => {
        assert.deepEqual(
            engineConflicts(22, {
                'js-controller': { version: '7.0.6', node: '>=18.0.0' },
                old: { version: '1.0.0', node: '>=12 <21' },
                none: { version: '1.0.0' },
            }),
            ['old@1.0.0 verlangt Node >=12 <21'],
        );
    });

    it('preflight blocks before anything changes', async () => {
        const result = await preflight({
            now: new Date(),
            halted: false,
            window: { start: '02:00', end: '05:00', ignore: true },
            conditions: [],
            readState: () => Promise.resolve(undefined),
            diskPath: temp,
            minFreeMb: 0,
            dependencyErrors: [],
            nodeErrors: { target: '22', errors: ['das Paket nodejs ist auf hold gesetzt'] },
        });
        assert.deepEqual(result, {
            ok: false,
            kind: 'block',
            reason: 'Update auf Node.js 22 nicht möglich: das Paket nodejs ist auf hold gesetzt',
        });
    });
});

describe('node: job', () => {
    const major = String(majorOf(process.version));
    const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, silly: () => {}, level: 'info' };

    /** A job that waits in phase node, as after the restart under the new Node.js */
    async function nodeJob(o: {
        status: Record<string, unknown> | null;
        running: string[];
        unitActive?: boolean;
        startedAt?: number;
        to?: string;
    }): Promise<{ jobs: JobManager; dir: string; finished: string[] }> {
        const dir = mkdtempSync(join(temp, 'job-'));
        const job: JobFile = {
            key: 'h:0',
            profileId: 'p',
            profileName: 'P',
            profileHash: 'h',
            retry: 0,
            targets: {},
            state: 'rollout',
            detail: '',
            steps: [
                { action: 'backup', status: 'ok' },
                { action: 'node', from: 'v20.18.0', to: o.to ?? major, status: 'running' },
            ],
            phase: 'node',
            createdAt: Date.now(),
            node: { unit: 'bee-node-1', startedAt: o.startedAt ?? Date.now(), instances: ['bee.0', 'javascript.0'] },
        };
        writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
        if (o.status) {
            writeFileSync(join(dir, 'node-status.json'), JSON.stringify(o.status));
        }
        const finished: string[] = [];
        const deps: JobDeps = {
            dataDir: dir,
            iobrokerJs: '',
            cwd: dir,
            log: silent as unknown as ioBroker.Logger,
            verifySeconds: 120,
            startTimeoutSeconds: 300,
            report: () => Promise.resolve(),
            installed: () => Promise.resolve({}),
            instancesOf: () => Promise.resolve([]),
            errorsSince: () => [],
            onFinished: (_job, result) => {
                finished.push(result);
                return Promise.resolve();
            },
            running: () => Promise.resolve(o.running),
            launchNode: () => Promise.resolve(),
            unitActive: () => Promise.resolve(o.unitActive ?? true),
        };
        const jobs = new JobManager(deps);
        await jobs.load();
        await jobs.poll();
        return { jobs, dir, finished };
    }
    const verdict = (dir: string): unknown =>
        existsSync(join(dir, 'node-verdict.json'))
            ? JSON.parse(readFileSync(join(dir, 'node-verdict.json'), 'utf8'))
            : null;
    const waiting = (ts = Date.now()): Record<string, unknown> => ({
        state: 'waiting',
        detail: '',
        ts,
        pid: 1,
        node: '',
    });

    it('keeps the new Node.js when the instances run again, then verifies', async () => {
        const { jobs, dir } = await nodeJob({ status: waiting(), running: ['bee.0', 'javascript.0', 'web.0'] });
        assert.deepEqual(verdict(dir), { ok: true });
        assert.equal(readFileSync(join(dir, 'node-verdict.json'), 'utf8'), '{"ok":true}\n', 'one line for grep');
        assert.equal(jobs.job?.phase, 'verify');
        assert.equal(jobs.job?.steps[1].status, 'ok');
        assert.match(jobs.job!.steps[1].detail!, /^v20\.18\.0 → v/);
    });

    it('waits for instances, and gives up after the time', async () => {
        const early = await nodeJob({ status: waiting(), running: ['bee.0'] });
        assert.equal(verdict(early.dir), null);
        assert.equal(early.jobs.job?.phase, 'node');
        assert.match(early.jobs.job!.detail, /warte auf javascript\.0/);

        const late = await nodeJob({ status: waiting(Date.now() - 3_600_000), running: ['bee.0'] });
        assert.deepEqual(verdict(late.dir), {
            ok: false,
            reason: `Unter Node.js ${process.version} laufen nicht: javascript.0`,
        });
        assert.equal(late.jobs.job?.phase, 'node', 'the script restarts ioBroker with the old version');
    });

    it('refuses when the agent still runs the old line', async () => {
        const { dir } = await nodeJob({ status: waiting(), running: ['bee.0', 'javascript.0'], to: '99' });
        assert.match((verdict(dir) as { reason: string }).reason, /weiter unter Node\.js/);
    });

    it('blocks after the script went back to the old version', async () => {
        const { jobs, finished } = await nodeJob({
            status: {
                state: 'restored',
                detail: 'Installation von Node.js 22 fehlgeschlagen',
                ts: 1,
                pid: 1,
                node: '',
            },
            running: [],
        });
        assert.deepEqual(finished, ['blocked']);
        assert.equal(jobs.job, null);
    });

    it('blocks when the script ended without a result', async () => {
        const gone = await nodeJob({
            status: { state: 'running', detail: '', ts: 1, pid: 1, node: '' },
            running: [],
            unitActive: false,
            startedAt: Date.now() - 120_000,
        });
        assert.deepEqual(gone.finished, ['blocked']);
        const starting = await nodeJob({ status: null, running: [], unitActive: false });
        assert.deepEqual(starting.finished, [], 'not within the first minute');
        const waitingGone = await nodeJob({ status: waiting(), running: ['bee.0'], unitActive: false });
        assert.deepEqual(waitingGone.finished, ['blocked']);
    });
});

/**
 * The script with stand-ins for apt, dpkg, systemctl, node and setcap: node -v answers from a file that the
 * stand-in of apt-get writes, systemctl start gives the verdict of the agent (file "verdict"), once.
 */
describe('node: script', { skip: process.platform === 'win32' && !process.env.BEE_TEST_BASH }, () => {
    const script = join(__dirname, '..', 'scripts', 'node-update.sh');
    const stubs: Record<string, string> = {
        node: 'cat "$STATE/node"',
        'dpkg-query': 'cat "$STATE/pkg"',
        getcap: 'echo "/usr/bin/node cap_net_admin,cap_net_raw=eip"',
        setcap: 'echo "setcap $*" >> "$STATE/calls"',
        chown: 'true',
        systemctl: [
            'echo "systemctl $*" >> "$STATE/calls"',
            'if [ "$1" = start ] && [ -f "$STATE/verdict" ] && [ ! -f "$STATE/started" ]; then',
            '  touch "$STATE/started"; cp "$STATE/verdict" "$DATA/node-verdict.json"',
            'fi',
        ].join('\n'),
        'apt-cache': [
            'm=$(sed -n -E \'s#.*node_([0-9]+)\\.x.*#\\1#p\' "$BEE_APT_SOURCES/nodesource.sources")',
            'echo "   nodejs | $m.4.0-1nodesource1 | https://deb.nodesource.com/node_$m.x nodistro/main arm64 Packages"',
            'echo "   nodejs | $m.3.0-1nodesource1 | https://deb.nodesource.com/node_$m.x nodistro/main arm64 Packages"',
        ].join('\n'),
        'apt-get': [
            'echo "apt-get $*" >> "$STATE/calls"',
            'for a in "$@"; do case $a in nodejs=*) v=${a#nodejs=} ;; esac; done',
            '[ -z "${v:-}" ] && exit 0',
            '[ -f "$STATE/fail-install" ] && [ "${v%%.*}" = "$(cat "$STATE/fail-install")" ] && exit 100',
            'echo "$v" > "$STATE/pkg"; echo "v${v%%-*}" > "$STATE/node"',
        ].join('\n'),
    };

    function run(o: { verdict?: string; failInstall?: string; wait?: number; noSource?: boolean }): {
        status: { state: string; detail: string };
        calls: string;
        source: string;
        node: string;
        dir: string;
    } {
        const root = mkdtempSync(join(temp, 'script-'));
        const bin = join(root, 'bin');
        const state = join(root, 'state');
        const data = join(root, 'data');
        const apt = join(root, 'apt');
        for (const d of [bin, state, data, apt]) {
            mkdirSync(d);
        }
        for (const [name, body] of Object.entries(stubs)) {
            writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
            chmodSync(join(bin, name), 0o755);
        }
        writeFileSync(join(state, 'node'), 'v20.18.0\n');
        writeFileSync(join(state, 'pkg'), '20.18.0-1nodesource1\n');
        writeFileSync(join(state, 'calls'), '');
        if (o.verdict) {
            writeFileSync(join(state, 'verdict'), o.verdict);
        }
        if (o.failInstall) {
            writeFileSync(join(state, 'fail-install'), o.failInstall);
        }
        if (!o.noSource) {
            writeFileSync(
                join(apt, 'nodesource.sources'),
                'Types: deb\nURIs: https://deb.nodesource.com/node_20.x\nSuites: nodistro\n',
            );
        }
        const r = spawnSync('bash', [script, data, '22', 'iobroker.service', String(o.wait ?? 0)], {
            env: {
                ...process.env,
                PATH: `${bin}${delimiter}${process.env.PATH}`,
                STATE: state,
                DATA: data,
                BEE_APT_SOURCES: apt,
            },
            encoding: 'utf8',
            timeout: 30_000,
        });
        assert.equal(r.error, undefined);
        return {
            status: JSON.parse(readFileSync(join(data, 'node-status.json'), 'utf8')),
            calls: readFileSync(join(state, 'calls'), 'utf8'),
            source: o.noSource ? '' : readFileSync(join(apt, 'nodesource.sources'), 'utf8'),
            node: readFileSync(join(state, 'node'), 'utf8').trim(),
            dir: data,
        };
    }

    it('updates, keeps the capabilities and stays with a positive verdict', () => {
        const r = run({ verdict: '{"ok":true}\n', wait: 30 });
        assert.equal(r.status.state, 'ok');
        assert.equal(r.node, 'v22.4.0', 'the newest of the line');
        assert.match(r.source, /node_22\.x/);
        assert.match(r.calls, /systemctl stop iobroker\.service[\s\S]*nodejs=22\.4\.0-1nodesource1[\s\S]*setcap/);
        assert.match(r.calls, /setcap cap_net_admin,cap_net_raw=eip /);
        assert.match(r.calls, /systemctl start iobroker\.service\n$/);
        assert.equal(existsSync(join(r.dir, 'nodesource.saved')), false);
    });

    it('goes back to the old package on a negative verdict', () => {
        const r = run({ verdict: '{"ok":false,"reason":"Unter Node.js v22.4.0 laufen nicht: zigbee.0"}\n', wait: 30 });
        assert.equal(r.status.state, 'restored');
        assert.equal(r.status.detail, 'Unter Node.js v22.4.0 laufen nicht: zigbee.0');
        assert.equal(r.node, 'v20.18.0');
        assert.match(r.source, /node_20\.x/);
        assert.match(r.calls, /--allow-downgrades[^\n]*nodejs=20\.18\.0-1nodesource1/);
        assert.equal(r.calls.match(/systemctl start/g)?.length, 2);
    });

    it('goes back without an answer of the agent', () => {
        const r = run({ wait: 0 });
        assert.equal(r.status.state, 'restored');
        assert.match(r.status.detail, /Keine Rückmeldung/);
        assert.equal(r.node, 'v20.18.0');
    });

    it('keeps the old version when the install fails', () => {
        const r = run({ failInstall: '22', verdict: '{"ok":true}\n', wait: 30 });
        assert.equal(r.status.state, 'restored');
        assert.match(r.status.detail, /Installation von Node\.js 22 fehlgeschlagen/);
        assert.equal(r.node, 'v20.18.0');
        assert.match(r.source, /node_20\.x/);
        assert.doesNotMatch(r.calls, /nodejs=20/, 'nothing to reinstall');
        assert.match(r.calls, /systemctl start iobroker\.service\n$/);
    });

    it('reports failed when the old version does not come back either', () => {
        const r = run({ failInstall: '20', verdict: '{"ok":false,"reason":"x"}\n', wait: 30 });
        assert.equal(r.status.state, 'failed');
        assert.match(r.status.detail, /Rückkehr zu Node\.js 20 gescheitert/);
        assert.match(r.calls, /systemctl start iobroker\.service\n$/, 'ioBroker runs in any case');
    });

    it('changes nothing without NodeSource', () => {
        const r = run({ noSource: true });
        assert.equal(r.status.state, 'failed');
        assert.equal(r.calls, '');
    });
});
