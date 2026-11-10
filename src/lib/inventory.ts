import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { instanceRunning, webExtensionOf } from './instances';
import type { AdapterInventory, InstanceInventory, Inventory } from './protocol';

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
    opts: { agentVersion: string; dataDir: string; lastBackup: Inventory['backup']['lastLocal'] },
): Promise<Inventory> {
    const adapterRows = await adapter.getObjectViewAsync('system', 'adapter', {
        startkey: 'system.adapter.',
        endkey: 'system.adapter.香',
    });
    const adapters: Record<string, AdapterInventory> = {};
    for (const row of adapterRows.rows) {
        const common = row.value?.common;
        if (common?.name && common.version) {
            adapters[common.name] = {
                version: common.version,
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
        if (!obj || obj.common.host !== adapter.host) {
            continue;
        }
        const id = obj._id.replace(/^system\.adapter\./, '');
        const web = webExtensionOf(obj);
        instances[id] = {
            enabled: !!obj.common.enabled,
            alive: await instanceRunning(obj, sid => adapter.getForeignStateAsync(sid), webInstances),
            mode: obj.common.mode,
            ...(web ? { webInstance: web } : {}),
        };
        if (obj.common.name === 'backitup' && obj.common.enabled) {
            const native = obj.native as Record<string, unknown>;
            offDevice ||= OFF_DEVICE_KEYS.some(k => native[k] === true);
        }
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
        backup: { lastLocal: opts.lastBackup ?? null, offDevice },
    };
}

/** Installed adapter versions (name -> version) */
export function installedVersions(inv: Inventory): Record<string, string> {
    return Object.fromEntries(Object.entries(inv.software.adapters).map(([n, a]) => [n, a.version]));
}
