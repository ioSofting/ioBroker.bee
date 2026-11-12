import type { CallResult } from './steps';
import type { AdapterInventory, AgentCommand, HostInventory, InstanceInventory, LogFile } from './protocol';
import { compareVersions } from './util';

/**
 * The other hosts of a multihost system. The agent runs on one host and maintains the others through their
 * js-controller, with the host commands admin uses as well: getHostInfo and getInstalled for the inventory, cmdExec for
 * the CLI (install, upgrade, remove, instances), restartController, upgradeOsPackages, getLogFiles and getLogFile.
 */

/** Longest a call of the CLI on another host may take, as in the runner */
export const REMOTE_CALL_TIMEOUT = 30 * 60_000;
/** Largest log file fetched from another host: js-controller sends it whole in one message */
export const MAX_REMOTE_LOG_BYTES = 20 * 1024 * 1024;

/** Sends a host command and waits for the answer; undefined if none comes in time */
export type SendToHost = (host: string, command: string, message: unknown, timeoutMs: number) => Promise<unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The CLI of ioBroker on another host (host command cmdExec): js-controller of that host runs `iobroker <args>` and
 * streams the output to the agent as the messages cmdStdout, cmdStderr and cmdExit, which come to onMessage.
 */
export class HostExec {
    private readonly pending = new Map<
        string,
        { out: string[]; resolve: (r: CallResult) => void; timer: NodeJS.Timeout }
    >();
    private counter = 0;

    /**
     * @param send sends the host command, without waiting for an answer
     */
    public constructor(private readonly send: (host: string, command: string, message: unknown) => void) {}

    /**
     * Runs one call of the CLI on the host
     *
     * @param host name of the host
     * @param args arguments of the CLI, none with a space (js-controller splits at spaces)
     * @param files files sent along: an argument equal to the name is replaced with its path on the host
     * @param timeoutMs longest wait for the end
     */
    public run(
        host: string,
        args: string[],
        files?: { name: string; file: string }[],
        timeoutMs = REMOTE_CALL_TIMEOUT,
    ): Promise<CallResult> {
        if (args.some(a => !a || /\s/.test(a))) {
            return Promise.resolve({ code: 1, output: `Ungültiges Argument für den Host ${host}` });
        }
        const id = `bee-${Date.now()}-${++this.counter}`;
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                const p = this.pending.get(id);
                this.pending.delete(id);
                resolve({
                    code: 1,
                    output: `${p?.out.join('\n') ?? ''}\nKeine Antwort von js-controller auf ${host} nach ${Math.round(timeoutMs / 60_000)} min`,
                });
            }, timeoutMs);
            this.pending.set(id, { out: [], resolve, timer });
            this.send(`system.host.${host}`, 'cmdExec', { id, data: args.join(' '), ...(files ? { files } : {}) });
        });
    }

    /**
     * A message to the agent: true if it belonged to a call of run
     *
     * @param msg the message
     * @param msg.command cmdStdout, cmdStderr or cmdExit
     * @param msg.message id of the call and the output or the exit code
     */
    public onMessage(msg: { command?: string; message?: unknown }): boolean {
        if (msg.command !== 'cmdStdout' && msg.command !== 'cmdStderr' && msg.command !== 'cmdExit') {
            return false;
        }
        const m = msg.message as { id?: unknown; data?: unknown } | undefined;
        const p = typeof m?.id === 'string' ? this.pending.get(m.id) : undefined;
        if (!p) {
            // js-controller sends cmdExit twice
            return typeof m?.id === 'string' && m.id.startsWith('bee-');
        }
        if (msg.command === 'cmdExit') {
            clearTimeout(p.timer);
            this.pending.delete(m!.id as string);
            p.resolve({ code: typeof m!.data === 'number' ? m!.data : 1, output: `${p.out.join('\n')}\n` });
        } else if (typeof m!.data === 'string' || typeof m!.data === 'number') {
            p.out.push(String(m!.data));
        }
        return true;
    }

    /** Ends all waiting calls (the agent stops) */
    public stop(): void {
        for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.resolve({ code: 1, output: `${p.out.join('\n')}\nDer Agent wurde beendet` });
            this.pending.delete(id);
        }
    }
}

/**
 * The adapters with their package on a host, from the answer of getInstalled; without js-controller
 *
 * @param answer the answer of the host
 * @param objects installedFrom of the adapter objects, by name
 */
export function adaptersFromInstalled(
    answer: unknown,
    objects: Record<string, string | undefined> = {},
): Record<string, AdapterInventory> | undefined {
    if (!isObject(answer)) {
        return undefined;
    }
    const adapters: Record<string, AdapterInventory> = {};
    for (const [name, info] of Object.entries(answer)) {
        if (name === 'hosts' || name === 'js-controller' || !isObject(info) || info.controller) {
            continue;
        }
        if (typeof info.version === 'string' && info.version) {
            adapters[name] = {
                version: info.version,
                ...(objects[name] ? { installedFrom: objects[name] } : {}),
            };
        }
    }
    return Object.fromEntries(Object.entries(adapters).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The system of a host from the answer of getHostInfo and its object
 *
 * @param info answer of getHostInfo
 * @param hostObj system.host.<name>
 */
export function systemFromHostInfo(
    info: unknown,
    hostObj: ioBroker.Object | null | undefined,
): HostInventory['system'] {
    const i = isObject(info) ? info : {};
    const native = (hostObj?.native ?? {}) as { os?: { platform?: unknown; arch?: unknown; release?: unknown } };
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const str = (...values: unknown[]): string => values.find((v): v is string => typeof v === 'string' && !!v) ?? '';
    return {
        platform: str(i.os, native.os?.platform),
        arch: str(i.Architecture, native.os?.arch),
        os: str(i.Platform, native.os?.platform),
        kernel: str(native.os?.release),
        model: str(i.Model),
        memTotal: num(i.RAM),
        diskTotal: num(i['Disk size']),
    };
}

/**
 * What the agent can do on another host
 *
 * @param jsController version of js-controller there
 * @param platform its platform (process.platform there)
 */
export function hostCommands(jsController: string, platform: string): AgentCommand[] {
    const commands: AgentCommand[] = ['instance', 'restart'];
    if (platform === 'linux' && jsController && compareVersions(jsController, '6.0.0') >= 0) {
        commands.push('osUpgrade');
    }
    commands.push('logs', 'adapter', 'software');
    return commands;
}

/** A log file of another host as getLogFiles lists it ("log/<host>/<transport>/<file>") */
export interface RemoteLogFile extends LogFile {
    transport: string;
}

/**
 * The log files of the answer of getLogFiles, newest first. js-controller gives no time of change: the date in the
 * name of the file (iobroker.2026-11-10.log) stands for it, the end of that day.
 *
 * @param answer answer of getLogFiles
 * @param host name of the host
 */
export function remoteLogFiles(answer: unknown, host: string): RemoteLogFile[] {
    const list = isObject(answer) && Array.isArray(answer.list) ? answer.list : [];
    const files = new Map<string, RemoteLogFile>();
    for (const entry of list) {
        if (!isObject(entry) || typeof entry.fileName !== 'string') {
            continue;
        }
        const parts = entry.fileName.split('/');
        // log/<host>/<transport>/<file>
        if (parts.length !== 4 || parts[0] !== 'log' || parts[1] !== host) {
            continue;
        }
        const name = parts[3];
        if (!/^[\w@+-][\w.@+-]*\.(log|gz)$/.test(name) || files.has(name)) {
            continue;
        }
        const date = /(\d{4}-\d{2}-\d{2})/.exec(name);
        const mtime = date ? new Date(`${date[1]}T23:59:59Z`).getTime() : 0;
        files.set(name, {
            name,
            size: typeof entry.size === 'number' ? entry.size : 0,
            mtime: Number.isFinite(mtime) ? mtime : 0,
            transport: parts[2],
        });
    }
    return [...files.values()].sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name)).slice(0, 200);
}

/**
 * The content of the answer of getLogFile; throws the error of the host
 *
 * @param answer answer of getLogFile: { data, gz, size } or { error }
 */
export function logFileData(answer: unknown): Buffer {
    if (!isObject(answer)) {
        throw new Error('Keine Antwort des Hosts');
    }
    if (typeof answer.error === 'string') {
        throw new Error(answer.error);
    }
    const data = answer.data;
    if (Buffer.isBuffer(data)) {
        return data;
    }
    // a Buffer that went through JSON
    if (isObject(data) && data.type === 'Buffer' && Array.isArray(data.data)) {
        return Buffer.from(data.data as number[]);
    }
    if (typeof data === 'string') {
        return Buffer.from(data, 'utf8');
    }
    throw new Error('Unbekanntes Format der Log-Datei');
}

/** What collectHosts needs from the adapter */
export interface HostSource {
    /** The host of the agent */
    own: string;
    hostObjects(): Promise<ioBroker.Object[]>;
    alive(host: string): Promise<boolean>;
    send: SendToHost;
    /** All instance objects of the system */
    instances(): Promise<ioBroker.InstanceObject[]>;
    /** How the inventory shows an instance */
    describe(obj: ioBroker.InstanceObject): Promise<InstanceInventory>;
    /** installedFrom of the adapter objects */
    installedFrom(): Promise<Record<string, string | undefined>>;
    osUpdates(host: string): Promise<HostInventory['osUpdates']>;
}

/**
 * The other hosts of the system. What a host answered last stays known while it is offline.
 *
 * @param src see HostSource
 * @param known the hosts as collected before, by name; updated
 */
export async function collectHosts(src: HostSource, known: Map<string, HostInventory>): Promise<HostInventory[]> {
    const objs = (await src.hostObjects()).filter(o => o._id !== `system.host.${src.own}`);
    const instances = await src.instances();
    const from = await src.installedFrom();
    const result: HostInventory[] = [];
    for (const obj of objs) {
        const name = obj._id.slice('system.host.'.length);
        const prev = known.get(name);
        const alive = await src.alive(name);
        const jsController = String((obj.common as { installedVersion?: string }).installedVersion || '');
        let node = prev?.node;
        let npm = prev?.npm;
        let system = prev?.system;
        let adapters = prev?.adapters;
        if (alive) {
            const info = await src.send(name, 'getHostInfo', null, 10_000);
            if (isObject(info)) {
                system = systemFromHostInfo(info, obj);
                node = typeof info['Node.js'] === 'string' ? info['Node.js'] : node;
                npm = typeof info.NPM === 'string' && info.NPM ? info.NPM : npm;
            }
            adapters = adaptersFromInstalled(await src.send(name, 'getInstalled', null, 30_000), from) ?? adapters;
        }
        const own: Record<string, InstanceInventory> = {};
        for (const inst of instances.filter(i => i.common.host === name)) {
            own[inst._id.replace(/^system\.adapter\./, '')] = await src.describe(inst);
        }
        const host: HostInventory = {
            name,
            alive,
            jsController,
            ...(node ? { node } : {}),
            ...(npm ? { npm } : {}),
            ...(system ? { system } : {}),
            ...(adapters ? { adapters } : {}),
            instances: own,
            commands: hostCommands(jsController, system?.platform || ''),
        };
        const os = await src.osUpdates(name);
        if (os) {
            host.osUpdates = os;
        }
        known.set(name, host);
        result.push(host);
    }
    for (const name of [...known.keys()]) {
        if (!result.some(h => h.name === name)) {
            known.delete(name);
        }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
}
