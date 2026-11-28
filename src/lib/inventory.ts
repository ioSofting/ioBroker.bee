import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { backitupInfo, mainBackitup } from './backup';
import { instanceRunning, onlyWww, webExtensionOf } from './instances';
import type { AdapterInventory, BackitupInfo, InstanceInventory, Inventory } from './protocol';

/**
 * Collects the inventory of this ioBroker system. Versions and system data only;
 * no measured values of the end customer (data minimization).
 */

async function readText(path: string): Promise<string | null> {
    try {
        return (await readFile(path, 'utf8')).trim();
    } catch {
        return null;
    }
}

async function osName(): Promise<string> {
    const release = await readText('/etc/os-release');
    const m = release && /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release);
    return m ? m[1] : `${os.type()} ${os.version?.() || os.release()}`;
}

let npmVersion: string | null = null;
async function npmVer(): Promise<string> {
    if (npmVersion === null) {
        npmVersion = await new Promise(resolve => {
            execFile(
                os.platform() === 'win32' ? 'npm.cmd' : 'npm',
                ['-v'],
                { timeout: 20_000, shell: os.platform() === 'win32' },
                (err, stdout) => resolve(err ? '' : stdout.trim()),
            );
        });
    }
    return npmVersion || '';
}

/** Sectors written to the SD card since boot (field 7 of /sys/block/mmcblk0/stat) */
export async function sdWrites(): Promise<number | null> {
    const stat = await readText('/sys/block/mmcblk0/stat');
    if (!stat) {
        return null;
    }
    const fields = stat.split(/\s+/);
    return fields.length > 6 ? parseInt(fields[6], 10) : null;
}

export async function diskInfo(path: string): Promise<{ total: number; free: number } | null> {
    try {
        const s = await statfs(path);
        return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
        return null;
    }
}

/** CPU times of all cores together (ms) and when they were read */
export interface CpuTimes {
    ts: number;
    busy: number;
    total: number;
}

/**
 * The CPU times now, for the use between two readings
 *
 * @param cpus os.cpus()
 * @param now current time
 */
export function cpuTimes(cpus: os.CpuInfo[] = os.cpus(), now = Date.now()): CpuTimes {
    let busy = 0;
    let total = 0;
    for (const { times: t } of cpus) {
        const all = t.user + t.nice + t.sys + t.idle + t.irq;
        total += all;
        busy += all - t.idle;
    }
    return { ts: now, busy, total };
}

/**
 * Use of the CPU between two readings in percent of all cores together, one decimal; null without time between them
 *
 * @param from the reading before
 * @param to the reading now
 */
export function cpuPercent(from: CpuTimes, to: CpuTimes): number | null {
    const total = to.total - from.total;
    if (!(total > 0)) {
        return null;
    }
    const share = Math.min(1, Math.max(0, (to.busy - from.busy) / total));
    return Math.round(share * 1000) / 10;
}

export async function cpuTemperature(): Promise<number | null> {
    const t = await readText('/sys/class/thermal/thermal_zone0/temp');
    return t ? Math.round(parseInt(t, 10) / 100) / 10 : null;
}

/** backitup targets that store the backup outside the device */
const OFF_DEVICE_KEYS = [
    'cifsEnabled',
    'ftpEnabled',
    'dropboxEnabled',
    'googledriveEnabled',
    'onedriveEnabled',
    'webdavEnabled',
    'sftpEnabled',
];

export async function collectInventory(
    adapter: ioBroker.Adapter,
    opts: {
        agentVersion: string;
        dataDir: string;
        lastBackup: Inventory['backup']['lastLocal'];
        /** node_modules of ioBroker on this host; missing: every adapter object counts */
        nodeModules?: string;
    },
): Promise<Inventory> {
    const adapterRows = await adapter.getObjectViewAsync('system', 'adapter', {
        startkey: 'system.adapter.',
        endkey: 'system.adapter.香',
    });
    const adapters: Record<string, AdapterInventory> = {};
    for (const row of adapterRows.rows) {
        const common = row.value?.common;
        if (common?.name && common.version) {
            // the objects are the same on every host: only what is installed here
            const version = opts.nodeModules ? packageVersion(opts.nodeModules, common.name) : common.version;
            if (!version) {
                continue;
            }
            adapters[common.name] = {
                version,
                ...(common.installedFrom ? { installedFrom: common.installedFrom } : {}),
            };
        }
    }

    const instanceRows = await adapter.getObjectViewAsync('system', 'instance', {
        startkey: 'system.adapter.',
        endkey: 'system.adapter.香',
    });
    const instances: Record<string, InstanceInventory> = {};
    let offDevice = false;
    const backitups: ioBroker.InstanceObject[] = [];
    // web instances on any host, for extensions that run in every one of them
    const webInstances = (): Promise<string[]> =>
        Promise.resolve(
            instanceRows.rows
                .map(r => r.value as ioBroker.InstanceObject | undefined)
                .filter(o => o?.common.name === 'web' && o.common.enabled)
                .map(o => o!._id.replace(/^system\.adapter\./, '')),
        );
    for (const row of instanceRows.rows) {
        const obj = row.value as ioBroker.InstanceObject | undefined;
        if (!obj) {
            continue;
        }
        if (obj.common.host === adapter.host) {
            const id = obj._id.replace(/^system\.adapter\./, '');
            instances[id] = await describeInstance(obj, sid => adapter.getForeignStateAsync(sid), webInstances);
        }
        // BackItUp saves the whole system, from whichever host it runs on
        if (obj.common.name === 'backitup') {
            backitups.push(obj);
            if (obj.common.enabled) {
                const native = obj.native as Record<string, unknown>;
                offDevice ||= OFF_DEVICE_KEYS.some(k => native[k] === true);
            }
        }
    }
    let backitup: BackitupInfo | null = null;
    const main = mainBackitup(backitups);
    if (main) {
        const id = main._id.replace(/^system\.adapter\./, '');
        const read = (state: string): Promise<ioBroker.State | null | undefined> =>
            adapter.getForeignStateAsync(`${id}.${state}`).catch(() => null);
        const [success, lastTime, history] = await Promise.all([
            read('history.iobrokerSuccess'),
            read('history.iobrokerLastTime'),
            read('history.json'),
        ]);
        backitup = backitupInfo(main, { success, lastTime, history });
    }

    const hostObj = await adapter.getForeignObjectAsync(`system.host.${adapter.host}`);
    const disk = await diskInfo(opts.dataDir);
    const model = (await readText('/proc/device-tree/model'))?.replace(/\0/g, '') || os.cpus()[0]?.model || '';

    return {
        agentVersion: opts.agentVersion,
        uuid: '',
        hostname: adapter.host || os.hostname(),
        software: {
            jsController: hostObj?.common?.installedVersion || '',
            node: process.version,
            npm: await npmVer(),
            adapters,
            instances,
        },
        system: {
            platform: os.platform(),
            arch: os.arch(),
            os: await osName(),
            kernel: os.release(),
            model,
            memTotal: os.totalmem(),
            diskTotal: disk?.total ?? 0,
        },
        backup: { lastLocal: opts.lastBackup ?? null, offDevice, backitup },
    };
}

/**
 * How the inventory shows an instance
 *
 * @param obj the instance object
 * @param readState reads a state
 * @param webInstances the enabled web instances
 */
export async function describeInstance(
    obj: ioBroker.InstanceObject,
    readState: (id: string) => Promise<ioBroker.State | null | undefined>,
    webInstances: () => Promise<string[]>,
): Promise<InstanceInventory> {
    const web = webExtensionOf(obj);
    return {
        enabled: !!obj.common.enabled,
        alive: await instanceRunning(obj, readState, webInstances),
        mode: obj.common.mode,
        ...(web ? { webInstance: web } : {}),
        ...(onlyWww(obj) ? { onlyWWW: true } : {}),
    };
}

/**
 * Version of the package of an adapter on this host, as js-controller finds it (getAdapterDir); null if it is not here,
 * e.g. installed on another host of the system
 *
 * @param nodeModules node_modules of ioBroker
 * @param name name of the adapter
 */
export function packageVersion(nodeModules: string, name: string): string | null {
    for (const dir of [join(nodeModules, `iobroker.${name}`), join(nodeModules, `ioBroker.${name}`)]) {
        try {
            const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown };
            if (typeof pkg.version === 'string' && pkg.version) {
                return pkg.version;
            }
        } catch {
            // not in this spelling
        }
    }
    return null;
}

/** Installed adapter versions (name -> version) */
export function installedVersions(inv: Inventory): Record<string, string> {
    return Object.fromEntries(Object.entries(inv.software.adapters).map(([n, a]) => [n, a.version]));
}
