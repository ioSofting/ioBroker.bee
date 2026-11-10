import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import type { JobStep } from './protocol';
import { readJson } from './util';

/**
 * Update of Node.js to the major line of the profile (DesiredProfile.node), only upwards.
 *
 * Node.js comes from the package nodejs of NodeSource, as the installer of ioBroker sets it up. The update
 * stops ioBroker, so the agent cannot do it itself: it starts scripts/node-update.sh as root in a systemd
 * unit of its own (sudo systemd-run, which the installer allows the user iobroker). After the restart the
 * agent checks under the new Node.js that the instances that ran before run again and writes its verdict;
 * without a positive verdict the script installs the old package again. Files in the data directory:
 * node-status.json (script), node-verdict.json (agent), node-update.log.
 */

export const NODE_STATUS = 'node-status.json';
export const NODE_VERDICT = 'node-verdict.json';
const NODE_SCRIPT = 'node-update.sh';

export interface NodeStatus {
    state: 'running' | 'waiting' | 'ok' | 'restored' | 'failed';
    detail: string;
    ts: number;
    pid: number;
    /** node -v at that moment */
    node: string;
}

/** Major line of a version, e.g. 22 for "v22.11.0", "22" or "22.x" */
export function majorOf(version: string | null | undefined): number | null {
    return semver.coerce(version ?? '')?.major || null;
}

/**
 * The step that brings Node.js to the major line of the profile; null if it runs that line already, or a
 * newer one (no downgrades)
 *
 * @param target DesiredProfile.node, e.g. "22"
 * @param current process.version
 */
export function nodeStep(target: string | undefined, current: string): JobStep | null {
    const want = majorOf(target);
    const have = majorOf(current);
    if (!want || !have || want <= have) {
        return null;
    }
    return { action: 'node', from: current, to: String(want), status: 'pending' };
}

/**
 * The systemd service ioBroker runs in, from /proc/self/cgroup, e.g. "iobroker.service"
 *
 * @param cgroup content of /proc/self/cgroup
 */
export function serviceOf(cgroup: string): string | null {
    return /\/system\.slice\/([^/\s]+\.service)/.exec(cgroup)?.[1] ?? null;
}

/** What the update of Node.js needs on this system */
export interface NodeFacts {
    platform: string;
    /** systemd service of ioBroker */
    service: string | null;
    /** root, or sudo without password for systemd-run */
    sudo: boolean;
    /** dpkg --print-architecture */
    arch: string | null;
    /** the running node is /usr/bin/node of the package nodejs */
    packaged: boolean;
    /** a source of NodeSource in /etc/apt/sources.list.d */
    source: boolean;
    /** the package nodejs is on hold */
    held: boolean;
    /** an off-device backup target is configured (BackItUp) */
    offDeviceBackup: boolean;
}

/** Reasons that block the update of Node.js; empty if it can run */
export function nodeBlockers(f: NodeFacts): string[] {
    if (f.platform !== 'linux') {
        return ['nur unter Linux möglich'];
    }
    const errors: string[] = [];
    if (!f.service) {
        errors.push('ioBroker läuft nicht als systemd-Dienst');
    }
    if (!f.sudo) {
        errors.push('kein sudo ohne Passwort für systemd-run (Installation mit --hardened?)');
    }
    if (!f.packaged || !f.source) {
        errors.push('Node.js stammt nicht aus dem Paket nodejs von NodeSource');
    } else if (f.arch !== 'amd64' && f.arch !== 'arm64') {
        errors.push(`NodeSource bietet für ${f.arch || 'diese Architektur'} kein Node.js an (nur amd64 und arm64)`);
    }
    if (f.held) {
        errors.push('das Paket nodejs ist auf hold gesetzt');
    }
    if (!f.offDeviceBackup) {
        errors.push('keine Sicherung außerhalb des Geräts (BackItUp)');
    }
    return errors;
}

/**
 * Installed packages whose engines.node excludes the major line
 *
 * @param target major line, e.g. 22
 * @param engines per package its version and engines.node
 */
export function engineConflicts(target: number, engines: Record<string, { version: string; node?: string }>): string[] {
    const line = `^${target}.0.0`;
    return Object.entries(engines)
        .filter(([, e]) => !!e.node && !!semver.validRange(e.node) && !semver.intersects(e.node, line))
        .map(([name, e]) => `${name}@${e.version} verlangt Node ${e.node}`);
}

/**
 * Version and engines.node of installed packages iobroker.<name>
 *
 * @param cwd directory of ioBroker, e.g. /opt/iobroker
 * @param names adapters, "js-controller" for the controller
 */
export function readEngines(cwd: string, names: string[]): Record<string, { version: string; node?: string }> {
    const result: Record<string, { version: string; node?: string }> = {};
    for (const name of names) {
        try {
            const pkg = JSON.parse(readFileSync(join(cwd, 'node_modules', `iobroker.${name}`, 'package.json'), 'utf8'));
            const node = pkg.engines?.node;
            result[name] = { version: String(pkg.version), ...(typeof node === 'string' ? { node } : {}) };
        } catch {
            // not installed as a package of its own
        }
    }
    return result;
}

function run(cmd: string, args: string[], timeout = 15_000): Promise<{ ok: boolean; out: string; err: string }> {
    return new Promise(resolve => {
        execFile(cmd, args, { timeout, windowsHide: true }, (error, stdout, stderr) =>
            resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr).trim() || error?.message || '' }),
        );
    });
}

const isRoot = (): boolean => process.getuid?.() === 0;

/** Root runs systemd-run itself, everybody else with sudo -n */
function asRoot(args: string[]): [string, string[]] {
    return isRoot() ? [args[0], args.slice(1)] : ['sudo', ['-n', ...args]];
}

function realpath(path: string): string | null {
    try {
        return realpathSync(path);
    } catch {
        return null;
    }
}

const SOURCES = ['/etc/apt/sources.list.d/nodesource.sources', '/etc/apt/sources.list.d/nodesource.list'];

/**
 * Looks at this system
 *
 * @param offDeviceBackup Inventory.backup.offDevice
 */
export async function nodeFacts(offDeviceBackup: boolean): Promise<NodeFacts> {
    const facts: NodeFacts = {
        platform: process.platform,
        service: null,
        sudo: false,
        arch: null,
        packaged: false,
        source: false,
        held: false,
        offDeviceBackup,
    };
    if (process.platform !== 'linux') {
        return facts;
    }
    const binary = realpath(process.execPath);
    const [cgroup, sudo, arch, owner, held] = await Promise.all([
        readFile('/proc/self/cgroup', 'utf8').catch(() => ''),
        run(...asRoot(['systemd-run', '--version'])),
        run('dpkg', ['--print-architecture']),
        binary ? run('dpkg', ['-S', binary]) : Promise.resolve({ ok: false, out: '', err: '' }),
        run('apt-mark', ['showhold', 'nodejs']),
    ]);
    facts.service = serviceOf(cgroup);
    facts.sudo = sudo.ok;
    facts.arch = arch.ok ? arch.out : null;
    facts.packaged = !!binary && binary === realpath('/usr/bin/node') && owner.ok && owner.out.startsWith('nodejs:');
    facts.source = SOURCES.some(
        f => existsSync(f) && /deb\.nodesource\.com\/node_\d+\.x/.test(readFileSync(f, 'utf8')),
    );
    facts.held = held.ok && held.out.split('\n').some(l => l.trim() === 'nodejs');
    return facts;
}

/** Name of the systemd unit for an update of Node.js */
export function nodeUnit(now = Date.now()): string {
    return `bee-node-${now}`;
}

/**
 * Starts scripts/node-update.sh as root in a unit of its own. It stops ioBroker, so this process ends soon.
 *
 * @param o what to start
 * @param o.dir data directory of the agent
 * @param o.target major line
 * @param o.service systemd service of ioBroker
 * @param o.unit name of the unit, see nodeUnit
 * @param o.waitSeconds how long the script waits for the verdict of the agent
 */
export async function launchNodeUpdate(o: {
    dir: string;
    target: string;
    service: string;
    unit: string;
    waitSeconds: number;
}): Promise<void> {
    await rm(join(o.dir, NODE_STATUS), { force: true });
    await rm(join(o.dir, NODE_VERDICT), { force: true });
    // a copy: the package of the agent may change while the script runs
    const script = join(o.dir, NODE_SCRIPT);
    await copyFile(join(__dirname, '..', '..', 'scripts', NODE_SCRIPT), script);
    const r = await run(
        ...asRoot([
            'systemd-run',
            `--unit=${o.unit}`,
            '--collect',
            '--quiet',
            `--description=ioBroker.bee: Node.js ${o.target}`,
            '/bin/bash',
            script,
            o.dir,
            o.target,
            o.service,
            String(o.waitSeconds),
        ]),
    );
    if (!r.ok) {
        throw new Error(`systemd-run: ${r.err || r.out || 'fehlgeschlagen'}`);
    }
}

/** Whether the unit of the script is still there (it is removed when the script ends) */
export async function unitActive(unit: string): Promise<boolean> {
    return (await run('systemctl', ['is-active', '--quiet', unit])).ok;
}

export function readNodeStatus(dir: string): Promise<NodeStatus | null> {
    return readJson<NodeStatus>(join(dir, NODE_STATUS));
}

/** Whether the agent already gave its verdict to the script, and which */
export async function readVerdict(dir: string): Promise<{ ok: boolean; reason?: string } | null> {
    return readJson<{ ok: boolean; reason?: string }>(join(dir, NODE_VERDICT));
}

/**
 * The verdict of the agent under the new Node.js. On one line: the script reads it with grep and sed.
 *
 * @param dir data directory of the agent
 * @param ok the instances run, the script keeps the new Node.js
 * @param reason otherwise why, the script goes back to the old one
 */
export async function writeVerdict(dir: string, ok: boolean, reason = ''): Promise<void> {
    const file = join(dir, NODE_VERDICT);
    const data = ok ? { ok: true } : { ok: false, reason: reason.replace(/["\\\r\n]/g, ' ').slice(0, 400) };
    await writeFile(`${file}.tmp`, `${JSON.stringify(data)}\n`);
    await rename(`${file}.tmp`, file);
}
