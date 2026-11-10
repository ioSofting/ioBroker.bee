import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { MAX_LOG_UPLOAD_BYTES, type LogFile } from './protocol';

/**
 * Log files of ioBroker for the fleet management: the agent lists them (command logList) and uploads one
 * of them to its own server on request (logFetch), compressed with gzip. Only files in the directories of
 * the file transports of iobroker.json, the way js-controller finds them for admin.
 */

/** At most this many files in a list (one per day, older ones compressed) */
const MAX_FILES = 200;

/**
 * Path of iobroker.json, found like js-controller does (getConfigFileName): IOBROKER_DATA_DIR, iobroker-data
 * next to node_modules, then the places of a development installation. Not utils.getConfig() of adapter-core:
 * that reads only conf/iobroker.json of js-controller, which a normal installation does not have.
 *
 * @param controllerDir directory of js-controller, e.g. /opt/iobroker/node_modules/iobroker.js-controller
 * @param env environment of the process
 * @returns null if there is none
 */
export function configFile(controllerDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
    const dataDir = env.IOBROKER_DATA_DIR;
    const candidates = [
        ...(dataDir ? [join(isAbsolute(dataDir) ? dataDir : join(controllerDir, dataDir), 'iobroker.json')] : []),
        join(controllerDir, '..', '..', 'iobroker-data', 'iobroker.json'),
        join(controllerDir, 'conf', 'iobroker.json'),
        join(controllerDir, 'data', 'iobroker.json'),
    ];
    return candidates.find(f => existsSync(f)) ?? null;
}

/**
 * Content of iobroker.json
 *
 * @param controllerDir see configFile
 * @param env see configFile
 * @returns null if there is none; throws if it is not readable
 */
export function readConfig(controllerDir: string, env: NodeJS.ProcessEnv = process.env): unknown {
    const file = configFile(controllerDir, env);
    return file ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/**
 * Directories of the file transports in iobroker.json (log.transport.*.filename, e.g. "log/iobroker").
 * Without any (no iobroker.json, no file transport) the default of js-controller: log below the root.
 *
 * @param config content of iobroker.json
 * @param root directory of ioBroker, e.g. /opt/iobroker; relative names are below it
 */
export function logDirs(config: unknown, root: string): string[] {
    const transports = (config as { log?: { transport?: Record<string, unknown> } } | null)?.log?.transport ?? {};
    const dirs = new Set<string>();
    for (const t of Object.values(transports) as { type?: string; filename?: string }[]) {
        if (t?.type !== 'file') {
            continue;
        }
        const filename = String(t.filename || 'log/iobroker').replace(/\\/g, '/');
        const dir = filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/')) || '/' : '.';
        dirs.add(isAbsolute(dir) || /^[A-Za-z]:/.test(dir) ? normalize(dir) : resolve(root, dir));
    }
    return dirs.size ? [...dirs] : [resolve(root, 'log')];
}

/** A file name the fleet management may ask for: no path, a log or a compressed log */
export function validLogName(name: unknown): name is string {
    return (
        typeof name === 'string' &&
        name.length <= 200 &&
        /^[\w@+-][\w.@+-]*\.(log|gz)$/.test(name) &&
        basename(name) === name &&
        !name.includes('..')
    );
}

/**
 * The log files in these directories, newest first. Without symbolic links: iobroker.current.log only
 * points to the file of today.
 *
 * @param dirs see logDirs
 */
export async function listLogFiles(dirs: string[]): Promise<LogFile[]> {
    const files = new Map<string, LogFile>();
    for (const dir of dirs) {
        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            continue;
        }
        for (const name of names) {
            if (!validLogName(name) || files.has(name)) {
                continue;
            }
            try {
                const s = await lstat(join(dir, name));
                if (s.isFile()) {
                    files.set(name, { name, size: s.size, mtime: Math.round(s.mtimeMs) });
                }
            } catch {
                // rotated away in between
            }
        }
    }
    return [...files.values()].sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name)).slice(0, MAX_FILES);
}

/**
 * Path of a log file out of the list; null if there is no such file
 *
 * @param dirs see logDirs
 * @param name file name out of the list
 */
export async function findLogFile(dirs: string[], name: unknown): Promise<string | null> {
    if (!validLogName(name)) {
        return null;
    }
    for (const dir of dirs) {
        try {
            if ((await lstat(join(dir, name))).isFile()) {
                return join(dir, name);
            }
        } catch {
            // not in this directory
        }
    }
    return null;
}

/** Counts the bytes going through and stops above the limit */
function limiter(max: number, count: (n: number) => void): Transform {
    let total = 0;
    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            total += chunk.length;
            count(total);
            callback(
                total > max ? new Error(`komprimiert größer als ${Math.round(max / 1024 / 1024)} MB`) : null,
                chunk,
            );
        },
    });
}

/**
 * Uploads a log file to the server, compressed with gzip (a .gz file as it is)
 *
 * @param file path of the log file
 * @param url upload URL of the own server (checked by the caller)
 * @param ticket one-time ticket of the server
 * @param ca trusted CAs for the certificate of the server
 * @returns the bytes sent
 */
export async function uploadLog(file: string, url: string, ticket: string, ca: string[]): Promise<number> {
    const u = new URL(url);
    let sent = 0;
    const req = (u.protocol === 'https:' ? https : http).request(url, {
        method: 'POST',
        ca: ca.length ? ca : undefined,
        timeout: 120_000,
        headers: {
            authorization: `Bearer ${ticket}`,
            'content-type': 'application/gzip',
            'x-file-name': encodeURIComponent(basename(file)),
        },
    });
    const answer = new Promise<void>((resolveAnswer, reject) => {
        req.on('response', res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d: string) => (body = (body + d).slice(0, 2000)));
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolveAnswer();
                } else {
                    let reason = body;
                    try {
                        reason = (JSON.parse(body) as { error?: string }).error || body;
                    } catch {
                        // plain text
                    }
                    reject(new Error(`Server: HTTP ${res.statusCode}${reason ? ` ${reason.slice(0, 200)}` : ''}`));
                }
            });
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
        req.on('error', reject);
    });
    // an error of the request also ends the pipeline; then the answer tells why
    answer.catch(() => {});
    const source: Readable = createReadStream(file);
    const steps = file.endsWith('.gz')
        ? [source, limiter(MAX_LOG_UPLOAD_BYTES, n => (sent = n)), req]
        : [source, createGzip(), limiter(MAX_LOG_UPLOAD_BYTES, n => (sent = n)), req];
    try {
        await pipeline(steps as unknown as [Readable, ...Transform[], http.ClientRequest]);
    } catch (e) {
        req.destroy();
        // the answer of the server is the better reason, if there is one
        await answer.catch(err => {
            throw err.message === 'socket hang up' ? e : err;
        });
        throw e;
    }
    await answer;
    return sent;
}
