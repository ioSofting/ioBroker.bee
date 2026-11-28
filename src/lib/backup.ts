import { backupMaxAgeDays, type BackitupInfo } from './protocol';

/**
 * The backup of ioBroker by BackItUp, from the settings of its instance and its states:
 * - history.iobrokerSuccess: written at the end of every run, true if it ended with exit code 0
 * - history.iobrokerLastTime: the time of that run as text, "error: ..." after a failed one, the default without digits
 * - history.json: the last runs of all types, each with "error": "none" or why it failed; with "Ignore backup errors"
 *   a run ends with exit code 0 even if a step failed, only its entry here tells
 */

const DAY = 24 * 3600_000;

/** Switches of BackItUp for targets outside the device */
const TARGETS: Record<string, string> = {
    ftpEnabled: 'ftp',
    cifsEnabled: 'cifs',
    dropboxEnabled: 'dropbox',
    webdavEnabled: 'webdav',
    googledriveEnabled: 'googledrive',
    onedriveEnabled: 'onedrive',
    sftpEnabled: 'sftp',
};

/** "Only stored locally" in the languages of BackItUp: the storage of a run without target outside the device */
const LOCAL_ONLY = new Set([
    'Only stored locally',
    'Nur lokal gespeichert',
    'Хранится только локально',
    'Armazenado apenas localmente',
    'Alleen lokaal opgeslagen',
    'Stocké uniquement localement',
    'Archiviato solo localmente',
    'Solo almacenado localmente',
    'Przechowywane tylko lokalnie',
    'Зберігається лише локально',
    '仅存储在本地',
]);

interface HistoryEntry {
    type?: string;
    storage?: string | string[];
    error?: string;
    timestamp?: number;
    filesizeBytes?: number | null;
}

/**
 * Days between two runs of a cron schedule (seconds, minutes, hours, day of month, month, day of week); only an
 * estimate for the check whether a backup is overdue
 *
 * @param cron e.g. "00 48 02 *\/2 * *"
 */
export function cronDays(cron: string): number {
    const f = String(cron || '')
        .trim()
        .split(/\s+/);
    if (f.length < 5) {
        return 1;
    }
    const dom = f[f.length - 3];
    const dow = f[f.length - 1];
    const every = /^\*\/(\d+)$/.exec(dom);
    if (every) {
        return Math.max(1, Number(every[1]));
    }
    if (/^\d+$/.test(dom)) {
        // one day of the month
        return 31;
    }
    if (dow !== '*' && dow !== '?') {
        // one day of the week, or several (Friday to Monday)
        return /^\d$/.test(dow) ? 7 : 3;
    }
    return 1;
}

function history(state: ioBroker.State | null | undefined): HistoryEntry[] {
    try {
        const list: unknown = JSON.parse(String(state?.val ?? '[]'));
        return Array.isArray(list) ? (list as HistoryEntry[]) : [];
    } catch {
        return [];
    }
}

function offDevice(e: HistoryEntry): boolean {
    // BackItUp lists the targets that were switched on, or "Only stored locally" in the language of the system
    return Array.isArray(e.storage) ? e.storage.length > 0 : !!e.storage && !LOCAL_ONLY.has(e.storage);
}

/**
 * What BackItUp does for the backup of ioBroker
 *
 * @param obj the instance, e.g. system.adapter.backitup.0
 * @param states its states history.iobrokerSuccess, history.iobrokerLastTime and history.json
 * @param states.success history.iobrokerSuccess
 * @param states.lastTime history.iobrokerLastTime
 * @param states.history history.json
 */
export function backitupInfo(
    obj: ioBroker.InstanceObject,
    states: {
        success?: ioBroker.State | null;
        lastTime?: ioBroker.State | null;
        history?: ioBroker.State | null;
    },
): BackitupInfo {
    const native = (obj.native || {}) as Record<string, unknown>;
    const targets = Object.entries(TARGETS)
        .filter(([key]) => native[key] === true)
        .map(([, name]) => (name === 'cifs' && native.connectType === 'NFS' ? 'nfs' : name));
    const runs = history(states.history)
        .filter(e => e && e.type === 'iobroker' && typeof e.timestamp === 'number')
        .sort((a, b) => b.timestamp! - a.timestamp!);

    let lastRun: BackitupInfo['lastRun'] = null;
    const text = states.lastTime?.val;
    // the default "No backups yet" has no digits, a date always has
    if (typeof text === 'string' && /\d/.test(text) && states.success) {
        lastRun = { ts: states.success.ts, ok: states.success.val === true && !/^error/i.test(text) };
    }
    const newest = runs[0];
    if (newest && (!lastRun || newest.timestamp! >= lastRun.ts - DAY)) {
        // the entry of the last run (it has the start of the run, the states the end)
        const error = newest.error && newest.error !== 'none' ? String(newest.error).slice(0, 300) : undefined;
        lastRun = lastRun
            ? { ...lastRun, ok: lastRun.ok && !error, ...(error ? { error } : {}) }
            : { ts: newest.timestamp!, ok: !error, ...(error ? { error } : {}) };
    }

    const ok = runs.filter(e => !e.error || e.error === 'none');
    const external = ok.find(offDevice);
    return {
        instance: obj._id.replace(/^system\.adapter\./, ''),
        enabled: !!obj.common.enabled,
        scheduled: native.minimalEnabled === true,
        everyDays:
            native.iobrokerCron === true
                ? cronDays(typeof native.iobrokerCronJob === 'string' ? native.iobrokerCronJob : '')
                : Math.max(1, Number(native.minimalEveryXDays) || 1),
        targets,
        lastRun,
        lastOk: ok[0] ? { ts: ok[0].timestamp!, size: ok[0].filesizeBytes ?? null } : null,
        lastOffDevice: external ? external.timestamp! : null,
    };
}

/**
 * Of several instances of BackItUp (a second one for another system, e.g. a CCU) the one that backs up ioBroker
 *
 * @param list instances of BackItUp on this host
 */
export function mainBackitup(list: ioBroker.InstanceObject[]): ioBroker.InstanceObject | undefined {
    const rank = (o: ioBroker.InstanceObject): number =>
        (o.common.enabled ? 2 : 0) + ((o.native as Record<string, unknown>)?.minimalEnabled === true ? 1 : 0);
    return [...list].sort((a, b) => rank(b) - rank(a) || a._id.localeCompare(b._id))[0];
}

/**
 * A backup outside the device recent enough for an update of the platform (Node.js): a current fleet backup, or
 * BackItUp. Without BackItUp information (it could not be read) the switched-on target counts, as before agent 0.2.11.
 *
 * @param backup inventory part backup
 * @param backup.offDevice a target outside the device is switched on
 * @param backup.backitup BackItUp, see BackitupInfo
 * @param now current time
 * @param fleetOk the last fleet backup uploaded or confirmed unchanged (since 0.7.0): as recent as a daily one
 */
export function recentOffDeviceBackup(
    backup: { offDevice: boolean; backitup?: BackitupInfo | null },
    now = Date.now(),
    fleetOk?: number | null,
): boolean {
    if (typeof fleetOk === 'number' && now - fleetOk <= backupMaxAgeDays({ everyDays: 1 }) * DAY) {
        return true;
    }
    const b = backup.backitup;
    if (b === undefined) {
        return backup.offDevice;
    }
    return (
        !!b &&
        b.enabled &&
        b.targets.length > 0 &&
        b.lastOffDevice !== null &&
        now - b.lastOffDevice <= backupMaxAgeDays(b) * DAY
    );
}

/** A fleet backup this young is the state right before an update of Node.js */
export const CHANGE_BACKUP_FRESH = 60 * 60_000;
/** Without a backup this long after the request, the server did not start one */
export const CHANGE_BACKUP_WAIT = 10 * 60_000;
/** A request this old is from another try (another night): the agent asks again */
export const CHANGE_BACKUP_ASK_AGAIN = 3 * 60 * 60_000;

/**
 * The backup right before an update of Node.js, with the fleet backup on (DesiredMessage.fleetBackup): go (there is
 * one of right now), ask the server for one (ResultMessage.wantsBackup), wait for it, or go on without it (none came,
 * or it failed): then the rule for a backup outside the device holds as before.
 */
export type ChangeBackup = { step: 'go' } | { step: 'ask' } | { step: 'wait' } | { step: 'without'; why: string };

/**
 * What the job does about the fleet backup before Node.js
 *
 * @param now current time
 * @param s what the agent knows
 * @param s.okAt the last fleet backup uploaded or confirmed unchanged
 * @param s.askedAt when the agent asked for one
 * @param s.failed the last fleet backup that failed, and why
 * @param s.failed.ts when it failed
 * @param s.failed.message why
 */
export function changeBackup(
    now: number,
    s: { okAt?: number; askedAt?: number; failed?: { ts: number; message: string } },
): ChangeBackup {
    if (s.okAt !== undefined && now - s.okAt < CHANGE_BACKUP_FRESH) {
        return { step: 'go' };
    }
    if (
        s.askedAt === undefined ||
        now - s.askedAt > CHANGE_BACKUP_ASK_AGAIN ||
        // the one it asked for came, but the job did not start in time (window, conditions)
        (s.okAt !== undefined && s.okAt >= s.askedAt)
    ) {
        return { step: 'ask' };
    }
    if (s.failed && s.failed.ts >= s.askedAt) {
        return { step: 'without', why: `fehlgeschlagen: ${s.failed.message}` };
    }
    if (now - s.askedAt > CHANGE_BACKUP_WAIT) {
        return { step: 'without', why: 'die Flottenverwaltung hat keine gestartet' };
    }
    return { step: 'wait' };
}

/** The agent keeps this many of the backups it made itself before jobs; older ones it deletes */
export const OWN_BACKUPS_KEEP = 3;

/** "…/2026_11_20-02_41_00_backupiobroker.tar.gz (48 MB)", as the step shows it, to the path */
export function backupPath(detail: string): string {
    return detail.replace(/\s+\(\d+ MB\)$/, '').trim();
}

/**
 * Which of its own backups the agent keeps, and which it deletes. Only files it made itself, never those of BackItUp
 * or one made by hand in the same folder; and only archives of `iobroker backup`.
 *
 * @param own the own backups so far, oldest first
 * @param added the one just made
 * @param keep how many to keep
 */
export function pruneOwnBackups(
    own: string[],
    added: string,
    keep = OWN_BACKUPS_KEEP,
): { keep: string[]; remove: string[] } {
    const all = [...own.filter(p => p && p !== added), added];
    const cut = Math.max(0, all.length - keep);
    return { keep: all.slice(cut), remove: all.slice(0, cut).filter(p => /_backupiobroker\.tar\.gz$/.test(p)) };
}
