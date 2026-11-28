import { createDecipheriv, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, open, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import semver from 'semver';
import { readArchive, stable, uploadUrlAllowed, type Sink } from './fleetBackup';
import { asRoot, run, serviceOf } from './node';
import { BACKUP_HEADER_BYTES, BACKUP_MAGIC, BACKUP_TAG_BYTES, type RestoreRequest } from './protocol';
import { readJson } from './util';

/**
 * A fleet backup back onto this device (command restore, see RestoreRequest): download, check and decrypt here,
 * the state of now as an own backup to go back to, then scripts/restore.sh in a systemd unit of its own, as root:
 * it stops ioBroker, runs `iobroker restore`, starts ioBroker and waits for the verdict of the agent. After the
 * restart the agent writes its settings from before back (restore.json), gives the verdict and answers the server.
 */

/** Marker of a restore that was started: survives `iobroker restore`, the data folder of bee is not in a backup */
export const RESTORE_FILE = 'restore.json';
export const RESTORE_STATUS = 'restore-status.json';
export const RESTORE_VERDICT = 'restore-verdict.json';
/** Download and decrypted archive */
export const RESTORE_DIR = 'restore';
const RESTORE_SCRIPT = 'restore.sh';
/** How long the script waits for the verdict of the agent after the start of ioBroker */
export const RESTORE_WAIT_SECONDS = 20 * 60;
/** The settings are written back at most this often; then something rewrites them, and the script goes back */
export const MAX_SETTING_WRITES = 3;

const MiB = 1024 * 1024;

export interface RestoreMarker {
    ref: string;
    by: string;
    /** Id of the backup in the fleet */
    id: string;
    /** When the backup was made (ms) */
    ts: number;
    archive: string;
    /** Archive of the state before, made right before the restore */
    rollback: string;
    unit: string;
    startedAt: number;
    /** The settings of this instance before the restore, decrypted (as this.config) */
    native: Record<string, unknown>;
    /** How often the settings were written back after the restore */
    writes?: number;
}

export interface RestoreStatus {
    state: 'running' | 'waiting' | 'ok' | 'restored' | 'failed';
    detail: string;
    ts: number;
}

export interface RestoreFacts {
    platform: string;
    /** systemd service of ioBroker */
    service: string | null;
    /** systemd-run as root (root, or sudo -n) */
    sudo: boolean;
}

/** Whether a restore can run here at all: Linux, ioBroker as systemd service, systemd-run as root */
export async function restoreFacts(): Promise<RestoreFacts> {
    const facts: RestoreFacts = { platform: process.platform, service: null, sudo: false };
    if (process.platform !== 'linux') {
        return facts;
    }
    const [cgroup, sudo] = await Promise.all([
        readFile('/proc/self/cgroup', 'utf8').catch(() => ''),
        run(...asRoot(['systemd-run', '--version'])),
    ]);
    facts.service = serviceOf(cgroup);
    facts.sudo = sudo.ok;
    return facts;
}

export function restorable(f: RestoreFacts): boolean {
    return f.platform === 'linux' && !!f.service && f.sudo;
}

/**
 * Why the restore is refused; null if it may run
 *
 * @param req the request of the server
 * @param facts this system
 * @param installed js-controller of this host
 * @param hosts number of hosts of the system
 * @param now the time
 */
export function restoreRefusal(
    req: RestoreRequest | undefined,
    facts: RestoreFacts,
    installed: string,
    hosts: number,
    now = Date.now(),
): string | null {
    const key = typeof req?.key === 'string' ? Buffer.from(req.key, 'base64') : Buffer.alloc(0);
    if (
        !req ||
        typeof req.id !== 'string' ||
        !/^bak_[\w-]{1,40}$/.test(req.id) ||
        key.length !== 32 ||
        typeof req.url !== 'string' ||
        !uploadUrlAllowed(req.url) ||
        !Number.isSafeInteger(req.size) ||
        req.size <= BACKUP_HEADER_BYTES + BACKUP_TAG_BYTES ||
        typeof req.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(req.sha256) ||
        typeof req.ts !== 'number' ||
        typeof req.expiresAt !== 'number' ||
        req.expiresAt < now ||
        (req.jsController !== undefined && !semver.valid(req.jsController))
    ) {
        return 'Unvollständige oder ungültige Anfrage';
    }
    if (facts.platform !== 'linux') {
        return 'Eine Sicherung einspielen geht nur unter Linux';
    }
    if (!facts.service) {
        return 'ioBroker läuft hier nicht als systemd-Dienst';
    }
    if (!facts.sudo) {
        return 'Der Agent darf systemd-run nicht als root starten (sudo)';
    }
    if (hosts > 1) {
        return `Das System hat ${hosts} Hosts: eine Sicherung einspielen geht nur bei einem einzigen Host`;
    }
    if (req.jsController && semver.valid(installed) && semver.gt(req.jsController, installed)) {
        return `Die Sicherung stammt von js-controller ${req.jsController}, installiert ist ${installed}: erst js-controller aktualisieren`;
    }
    return null;
}

/** Free bytes of the file system of the directory; null if unknown */
export async function freeBytes(dir: string): Promise<number | null> {
    try {
        const s = await statfs(dir);
        return s.bavail * s.bsize;
    } catch {
        return null;
    }
}

/**
 * What the restore needs on the disk: the encrypted file, the archive, the backup of now (about as large)
 *
 * @param size size of the encrypted file
 */
export function spaceNeeded(size: number): number {
    return size * 3 + 200 * MiB;
}

class DownloadError extends Error {
    constructor(
        message: string,
        /** Trying again does not help (the address is refused) */
        readonly permanent: boolean,
    ) {
        super(message);
    }
}

/** GET from the offset on, appended to the file (the whole file again if the storage ignores the range) */
function getFrom(url: string, file: string, offset: number, onData: (n: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
            u,
            { method: 'GET', headers: offset ? { Range: `bytes=${offset}-` } : {}, timeout: 2 * 60_000 },
            (res: IncomingMessage) => {
                const status = res.statusCode ?? 0;
                if (status !== 200 && status !== 206) {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.length < 64 && chunks.push(c));
                    res.on('end', () => {
                        const code = /<Code>([^<]*)<\/Code>/.exec(Buffer.concat(chunks).toString('utf8'))?.[1];
                        const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
                        reject(new DownloadError(`Speicher antwortet ${status}${code ? ` ${code}` : ''}`, permanent));
                    });
                    res.on('error', reject);
                    return;
                }
                // 200 on a range: the whole file again
                const append = status === 206 && offset > 0;
                if (!append && offset > 0) {
                    onData(-offset);
                }
                pipeline(
                    res,
                    new Transform({
                        transform(chunk: Buffer, _enc, cb) {
                            onData(chunk.length);
                            cb(null, chunk);
                        },
                    }),
                    createWriteStream(file, { flags: append ? 'a' : 'w' }),
                ).then(resolve, reject);
            },
        );
        req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Laden')));
        req.on('error', reject);
        req.end();
    });
}

async function sizeOf(file: string): Promise<number> {
    try {
        return (await stat(file)).size;
    } catch {
        return 0;
    }
}

async function sha256Of(file: string): Promise<string> {
    const hash = createHash('sha256');
    await pipeline(
        createReadStream(file),
        new Writable({
            write(chunk: Buffer, _enc, cb) {
                hash.update(chunk);
                cb();
            },
        }),
    );
    return hash.digest('hex');
}

const RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/**
 * Downloads the encrypted file of the backup; a broken connection goes on where it stood (Range). Checks size and
 * SHA-256 at the end.
 *
 * @param file where the file goes
 * @param req address, size, SHA-256 and validity
 * @param opts progress, stop and the pauses between tries
 * @param opts.onProgress bytes so far and in all
 * @param opts.stopped the adapter stops: give up
 * @param opts.delays pauses between tries (tests)
 * @param opts.log a try fails and is made again
 */
export async function downloadBackup(
    file: string,
    req: Pick<RestoreRequest, 'url' | 'size' | 'sha256' | 'expiresAt'>,
    opts: {
        onProgress?: (done: number, total: number) => void;
        stopped?: () => boolean;
        delays?: number[];
        log?: (text: string) => void;
    } = {},
): Promise<void> {
    const delays = opts.delays ?? RETRY_DELAYS;
    for (let attempt = 0; ; attempt++) {
        let have = await sizeOf(file);
        if (have > req.size) {
            await rm(file, { force: true });
            have = 0;
        }
        if (have === req.size) {
            break;
        }
        let done = have;
        try {
            await getFrom(req.url, file, have, n => {
                done += n;
                opts.onProgress?.(done, req.size);
            });
            if ((await sizeOf(file)) < req.size) {
                throw new DownloadError('Verbindung vor dem Ende abgebrochen', false);
            }
        } catch (e) {
            const wait = delays[Math.min(attempt, delays.length - 1)];
            if ((e as DownloadError).permanent || opts.stopped?.() || Date.now() + wait > req.expiresAt) {
                throw new Error(`Laden der Sicherung: ${(e as Error).message}`);
            }
            opts.log?.(`Download failed (${(e as Error).message}), again in ${Math.round(wait / 1000)} s`);
            await new Promise(r => setTimeout(r, wait));
        }
    }
    if ((await sha256Of(file)) !== req.sha256) {
        await rm(file, { force: true });
        throw new Error('Die geladene Sicherung ist beschädigt (SHA-256 stimmt nicht)');
    }
}

/**
 * Decrypts the file of the storage (see BackupRequest): magic, IV, AES-256-GCM, tag; the id of the backup in the
 * additional data. Nothing stays of a file that does not pass.
 *
 * @param src the encrypted file
 * @param dst the archive
 * @param key 32 bytes
 * @param id id of the backup
 */
export async function decryptBackup(src: string, dst: string, key: Buffer, id: string): Promise<void> {
    const size = await sizeOf(src);
    if (size < BACKUP_HEADER_BYTES + BACKUP_TAG_BYTES) {
        throw new Error('Die Datei ist keine Flottensicherung (zu kurz)');
    }
    const fd = await open(src, 'r');
    const header = Buffer.alloc(BACKUP_HEADER_BYTES);
    const tag = Buffer.alloc(BACKUP_TAG_BYTES);
    try {
        await fd.read(header, 0, BACKUP_HEADER_BYTES, 0);
        await fd.read(tag, 0, BACKUP_TAG_BYTES, size - BACKUP_TAG_BYTES);
    } finally {
        await fd.close();
    }
    if (header.subarray(0, BACKUP_MAGIC.length).toString('latin1') !== BACKUP_MAGIC) {
        throw new Error('Die Datei ist keine Flottensicherung');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(BACKUP_MAGIC.length));
    decipher.setAAD(Buffer.concat([header, Buffer.from(id, 'utf8')]));
    decipher.setAuthTag(tag);
    const end = size - BACKUP_TAG_BYTES - 1;
    try {
        await pipeline(
            end >= BACKUP_HEADER_BYTES
                ? createReadStream(src, { start: BACKUP_HEADER_BYTES, end })
                : (async function* () {})(),
            new Transform({
                transform(chunk: Buffer, _enc, cb) {
                    cb(null, decipher.update(chunk));
                },
                flush(cb) {
                    try {
                        cb(null, decipher.final());
                    } catch {
                        cb(
                            new Error(
                                'Entschlüsseln fehlgeschlagen: anderer Schlüssel, andere Sicherung oder beschädigt',
                            ),
                        );
                    }
                },
            }),
            createWriteStream(dst),
        );
    } catch (e) {
        await rm(dst, { force: true });
        throw e;
    }
}

/**
 * Whether the archive holds the object (objects.jsonl, since js-controller 7); null for an older archive
 * (backup.json), which is not read here
 *
 * @param archive the .tar.gz
 * @param id e.g. system.adapter.bee.0
 */
export async function archiveHasObject(archive: string, id: string): Promise<boolean | null> {
    const needle = JSON.stringify(id);
    const sink = (): Sink => {
        let found = false;
        let rest = '';
        const line = (text: string): void => {
            if (found || !text.includes(needle)) {
                return;
            }
            try {
                found = (JSON.parse(text) as { _id?: unknown })._id === id;
            } catch {
                // not an object
            }
        };
        return {
            add: d => {
                const lines = (rest + d.toString('utf8')).split('\n');
                rest = lines.pop() ?? '';
                lines.forEach(line);
            },
            end: () => {
                line(rest);
                return found ? 'yes' : 'no';
            },
        };
    };
    const entries = await readArchive(archive, name => {
        const path = name.replace(/^\.?\//, '').replace(/^backup\//, '');
        return path === 'objects.jsonl' || path === 'backup.json' ? sink() : null;
    });
    const jsonl = [...entries].find(([name]) => /(^|\/)objects\.jsonl$/.test(name));
    if (jsonl) {
        return jsonl[1] === 'yes';
    }
    return null;
}

/** Whether the settings are the same, whatever the order of the keys */
export function sameSettings(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    return stable(a) === stable(b);
}

/** Name of the systemd unit of a restore */
export function restoreUnit(now = Date.now()): string {
    return `bee-restore-${now}`;
}

/**
 * Starts scripts/restore.sh as root in a unit of its own. It stops ioBroker, so this process ends soon.
 *
 * @param o what to start
 * @param o.dir data directory of the agent
 * @param o.iobrokerDir directory of ioBroker (with node_modules)
 * @param o.archive the backup to play in
 * @param o.rollback the backup of the state before
 * @param o.service systemd service of ioBroker
 * @param o.unit name of the unit, see restoreUnit
 * @param o.waitSeconds how long the script waits for the verdict of the agent
 * @param o.force another js-controller than in the backup: restore --force
 * @param o.user the user of ioBroker, the CLI runs as it
 * @param o.node Node.js of ioBroker
 */
export async function launchRestore(o: {
    dir: string;
    iobrokerDir: string;
    archive: string;
    rollback: string;
    service: string;
    unit: string;
    waitSeconds: number;
    force: boolean;
    user: string;
    node: string;
}): Promise<void> {
    await rm(join(o.dir, RESTORE_STATUS), { force: true });
    await rm(join(o.dir, RESTORE_VERDICT), { force: true });
    // a copy: the package of the agent is put aside while the script runs
    const script = join(o.dir, RESTORE_SCRIPT);
    await copyFile(join(__dirname, '..', '..', 'scripts', RESTORE_SCRIPT), script);
    const r = await run(
        ...asRoot([
            'systemd-run',
            `--unit=${o.unit}`,
            '--collect',
            '--quiet',
            '--description=ioBroker.bee: Sicherung einspielen',
            '/bin/bash',
            script,
            o.dir,
            o.iobrokerDir,
            o.archive,
            o.rollback,
            o.service,
            String(o.waitSeconds),
            o.force ? '1' : '0',
            o.user,
            o.node,
        ]),
    );
    if (!r.ok) {
        throw new Error(`systemd-run: ${r.err || r.out || 'fehlgeschlagen'}`);
    }
}

export function readRestoreStatus(dir: string): Promise<RestoreStatus | null> {
    return readJson<RestoreStatus>(join(dir, RESTORE_STATUS));
}

export function readRestoreVerdict(dir: string): Promise<{ ok: boolean; reason?: string } | null> {
    return readJson<{ ok: boolean; reason?: string }>(join(dir, RESTORE_VERDICT));
}

/**
 * The verdict of the agent after the restore. On one line: the script reads it with grep and sed.
 *
 * @param dir data directory of the agent
 * @param ok the agent runs with its settings and reaches the fleet management: the script keeps the backup
 * @param reason otherwise why, the script goes back to the state before
 */
export async function writeRestoreVerdict(dir: string, ok: boolean, reason = ''): Promise<void> {
    const file = join(dir, RESTORE_VERDICT);
    const data = ok ? { ok: true } : { ok: false, reason: reason.replace(/["\\\r\n]/g, ' ').slice(0, 400) };
    await writeFile(`${file}.tmp`, `${JSON.stringify(data)}\n`);
    await rename(`${file}.tmp`, file);
}
