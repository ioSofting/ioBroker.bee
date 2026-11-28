import { spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { BACKUP_MAGIC, type BackupRequest } from './protocol';

/**
 * The fleet backup on the device (command backup): `iobroker backup`, the hash of the configuration in the archive,
 * the archive encrypted for the storage of the fleet, and the upload of its parts to the presigned addresses of the
 * server. No dependencies besides Node.js.
 */

/** Objects that are caches, refreshed by themselves: they do not make a new backup */
const VOLATILE_OBJECTS = new Set(['system.repositories', 'system.licenses']);

/** Sorted keys, so that the same object gives the same text */
function stable(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map(stable).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
        .sort()
        .filter(k => obj[k] !== undefined)
        .map(k => `${JSON.stringify(k)}:${stable(obj[k])}`)
        .join(',')}}`;
}

/**
 * One object of objects.jsonl as it counts for the configuration: without the time and author of its last change,
 * the host objects without their hardware facts; caches not at all
 *
 * @param line a line of objects.jsonl
 */
export function objectForHash(line: string): string | null {
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
        // counts as it is
        return line;
    }
    if (!obj || typeof obj !== 'object') {
        return line;
    }
    const id = typeof obj._id === 'string' ? obj._id : '';
    if (VOLATILE_OBJECTS.has(id)) {
        return null;
    }
    const { ts: _ts, from: _from, user: _user, ...rest } = obj;
    if (rest.type === 'host') {
        // processes, memory, network interfaces: written by js-controller on every start
        delete rest.native;
    }
    return stable(rest);
}

/** What a file in the archive adds to the hash */
type Sink = { add(data: Buffer): void; end(): string };

function fileSink(): Sink {
    const h = createHash('sha256');
    return {
        add: d => {
            h.update(d);
        },
        end: () => h.digest('hex'),
    };
}

/** objects.jsonl: every object normalized, in any order */
function objectsSink(): Sink {
    const hashes: string[] = [];
    let rest = '';
    const line = (text: string): void => {
        if (!text.trim()) {
            return;
        }
        const normal = objectForHash(text);
        if (normal !== null) {
            hashes.push(createHash('sha256').update(normal).digest('hex'));
        }
    };
    return {
        add: d => {
            const text = rest + d.toString('utf8');
            const lines = text.split('\n');
            rest = lines.pop() ?? '';
            lines.forEach(line);
        },
        end: () => {
            line(rest);
            return createHash('sha256').update(hashes.sort().join('\n')).digest('hex');
        },
    };
}

/**
 * Which files of the archive count for the configuration: config.json (iobroker.json), objects.jsonl and the files
 * of ioBroker (files/, e.g. the projects of vis-2). Not the states, which change all the time, and not the data
 * folders of instances copied in beside them (their databases change all the time too).
 *
 * @param name path in the archive, e.g. "backup/objects.jsonl"
 */
export function sinkFor(name: string): Sink | null {
    const path = name.replace(/^\.?\//, '').replace(/^backup\//, '');
    if (path === 'objects.jsonl') {
        return objectsSink();
    }
    if (path === 'config.json' || path.startsWith('files/')) {
        return fileSink();
    }
    return null;
}

function text(block: Buffer, start: number, length: number): string {
    const raw = block.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
}

function octal(block: Buffer, start: number, length: number): number {
    const raw = block.subarray(start, start + length);
    if (raw[0] & 0x80) {
        // base-256 of GNU tar for large sizes
        let n = 0;
        for (let i = 1; i < raw.length; i++) {
            n = n * 256 + raw[i];
        }
        return n;
    }
    const s = text(block, start, length).trim();
    return s ? parseInt(s, 8) : 0;
}

/**
 * Reads a tar archive and hashes the entries that count (sinkFor), with their names; long names of GNU tar and of pax
 * as node-tar writes them are understood
 */
class TarHash extends Writable {
    private buf: Buffer = Buffer.alloc(0);
    private entry: {
        name: string;
        remaining: number;
        pad: number;
        sink: Sink | null;
        meta: Buffer[] | null;
        type: string;
    } | null = null;
    private nextName: string | null = null;
    readonly entries = new Map<string, string>();

    override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        try {
            this.drain();
            cb();
        } catch (e) {
            cb(e as Error);
        }
    }

    private drain(): void {
        for (;;) {
            if (!this.entry) {
                if (this.buf.length < 512) {
                    return;
                }
                const h = this.buf.subarray(0, 512);
                this.buf = this.buf.subarray(512);
                if (h.every(b => b === 0)) {
                    continue;
                }
                const size = octal(h, 124, 12);
                const type = String.fromCharCode(h[156] || 48);
                const prefix = text(h, 257, 6) === 'ustar' ? text(h, 345, 155) : '';
                const name = this.nextName ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100));
                const meta = type === 'L' || type === 'x' || type === 'g';
                if (!meta) {
                    this.nextName = null;
                }
                this.entry = {
                    name,
                    remaining: size,
                    pad: (512 - (size % 512)) % 512,
                    // regular files only (0, and \0 of old tars, 7 contiguous)
                    sink: !meta && (type === '0' || type === '7') ? sinkFor(name) : null,
                    meta: meta ? [] : null,
                    type,
                };
                continue;
            }
            const e = this.entry;
            if (e.remaining > 0) {
                const n = Math.min(e.remaining, this.buf.length);
                if (!n) {
                    return;
                }
                const data = this.buf.subarray(0, n);
                e.sink?.add(data);
                e.meta?.push(Buffer.from(data));
                this.buf = this.buf.subarray(n);
                e.remaining -= n;
                if (e.remaining > 0) {
                    return;
                }
            }
            if (e.pad > 0) {
                const n = Math.min(e.pad, this.buf.length);
                if (!n) {
                    return;
                }
                this.buf = this.buf.subarray(n);
                e.pad -= n;
                if (e.pad > 0) {
                    return;
                }
            }
            if (e.meta) {
                const data = Buffer.concat(e.meta);
                if (e.type === 'L') {
                    this.nextName = text(data, 0, data.length);
                } else if (e.type === 'x') {
                    const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1];
                    if (path) {
                        this.nextName = path;
                    }
                }
            } else if (e.sink) {
                this.entries.set(e.name.replace(/^\.?\//, ''), e.sink.end());
            }
            this.entry = null;
        }
    }
}

/**
 * Hash of the configuration in an archive of `iobroker backup`: the same as long as objects, files and iobroker.json
 * are the same, whatever the states and the time of the backup
 *
 * @param archive the .tar.gz
 */
export async function configHash(archive: string): Promise<string> {
    const tar = new TarHash();
    await pipeline(createReadStream(archive), createGunzip(), tar);
    const all = [...tar.entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return createHash('sha256')
        .update(all.map(([name, hash]) => `${name}\0${hash}`).join('\n'))
        .digest('hex');
}

/**
 * Encrypts the archive for the storage: magic, IV, AES-256-GCM, tag; magic, IV and the id of the backup as
 * additional data (see BackupRequest)
 *
 * @param src the archive
 * @param dst the encrypted file
 * @param key 32 bytes
 * @param id id of the backup
 */
export async function encryptBackup(
    src: string,
    dst: string,
    key: Buffer,
    id: string,
): Promise<{ size: number; sha256: string }> {
    const iv = randomBytes(12);
    const header = Buffer.concat([Buffer.from(BACKUP_MAGIC, 'latin1'), iv]);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.concat([header, Buffer.from(id, 'utf8')]));
    const hash = createHash('sha256');
    let size = 0;
    const out = (b: Buffer): Buffer => {
        hash.update(b);
        size += b.length;
        return b;
    };
    let started = false;
    await pipeline(
        createReadStream(src),
        new Transform({
            transform(chunk: Buffer, _enc, cb) {
                const head = started ? [] : [out(header)];
                started = true;
                cb(null, Buffer.concat([...head, out(cipher.update(chunk))]));
            },
            flush(cb) {
                const head = started ? [] : [out(header)];
                cb(null, Buffer.concat([...head, out(cipher.final()), out(cipher.getAuthTag())]));
            },
        }),
        createWriteStream(dst),
    );
    return { size, sha256: hash.digest('hex') };
}

/** Only https; http for this machine (tests, a storage on the device) */
export function uploadUrlAllowed(url: string): boolean {
    try {
        const u = new URL(url);
        return (
            u.protocol === 'https:' ||
            (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
        );
    } catch {
        return false;
    }
}

class UploadError extends Error {
    constructor(
        message: string,
        /** Trying again does not help (the address is refused) */
        readonly permanent: boolean,
    ) {
        super(message);
    }
}

/** PUT of one part from the file; the ETag of the answer */
function putPart(url: string, file: string, start: number, end: number, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
            u,
            { method: 'PUT', headers: { 'Content-Length': end - start + 1 }, timeout: timeoutMs },
            (res: IncomingMessage) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.length < 64 && chunks.push(c));
                res.on('end', () => {
                    const status = res.statusCode ?? 0;
                    const etag = res.headers.etag;
                    if (status === 200 && typeof etag === 'string' && etag) {
                        return resolve(etag);
                    }
                    const body = Buffer.concat(chunks).toString('utf8');
                    const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
                    // the address is wrong or ran out: no use trying again; 408, 429 and 5xx may pass
                    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
                    reject(new UploadError(`Speicher antwortet ${status}${code ? ` ${code}` : ''}`, permanent));
                });
                res.on('error', reject);
            },
        );
        req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Hochladen')));
        req.on('error', reject);
        const stream = createReadStream(file, { start, end });
        stream.on('error', e => req.destroy(e));
        stream.pipe(req);
    });
}

/** Waits between tries of a part: a mobile connection may be gone for a while */
const RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/**
 * Uploads the encrypted file part by part. A part that fails is tried again (longer and longer pauses) until the
 * addresses run out; the parts done stay done, so a broken connection goes on where it stood.
 *
 * @param file the encrypted file
 * @param size its size
 * @param req the request of the server (parts, partSize, expiresAt)
 * @param opts progress, stop and the pauses between tries
 * @param opts.log a part fails and is tried again
 * @param opts.onPart after each part: done and total
 * @param opts.stopped the adapter stops: give up
 * @param opts.delays pauses between tries (tests)
 * @returns the ETags of the parts in their order
 */
export async function uploadParts(
    file: string,
    size: number,
    req: Pick<BackupRequest, 'parts' | 'partSize' | 'expiresAt'>,
    opts: {
        onPart?: (done: number, total: number) => void;
        stopped?: () => boolean;
        delays?: number[];
        log?: (text: string) => void;
    } = {},
): Promise<string[]> {
    const total = Math.ceil(size / req.partSize);
    if (total > req.parts.length) {
        throw new Error(`Zu groß: ${total} Teile, erlaubt sind ${req.parts.length}`);
    }
    const delays = opts.delays ?? RETRY_DELAYS;
    const etags: string[] = [];
    for (let i = 0; i < total; i++) {
        const start = i * req.partSize;
        const end = Math.min(size, start + req.partSize) - 1;
        for (let attempt = 0; ; attempt++) {
            try {
                etags.push(await putPart(req.parts[i], file, start, end, 5 * 60_000));
                break;
            } catch (e) {
                const wait = delays[Math.min(attempt, delays.length - 1)];
                if ((e as UploadError).permanent || opts.stopped?.() || Date.now() + wait > req.expiresAt) {
                    throw new Error(`Teil ${i + 1} von ${total}: ${(e as Error).message}`);
                }
                opts.log?.(
                    `Part ${i + 1} of ${total} failed (${(e as Error).message}), again in ${Math.round(wait / 1000)} s`,
                );
                await new Promise(r => setTimeout(r, wait));
            }
        }
        opts.onPart?.(i + 1, total);
    }
    return etags;
}

/**
 * `iobroker backup` with the CLI of this host; the archive it made
 *
 * @param iobrokerJs path of iobroker.js of js-controller
 * @param cwd the directory of ioBroker
 */
export function runBackup(iobrokerJs: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const out: string[] = [];
        const child = spawn(process.execPath, [iobrokerJs, 'backup'], {
            cwd,
            env: { ...process.env, NODE_ENV: 'production' },
            windowsHide: true,
            timeout: 30 * 60_000,
            killSignal: 'SIGKILL',
        });
        const onData = (d: Buffer): void => {
            out.push(d.toString());
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', reject);
        child.on('close', code => {
            const output = out.join('');
            const file = /Backup created: (.+)$/m.exec(output)?.[1]?.trim();
            if (code === 0 && file) {
                return resolve(file);
            }
            const last = output
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(Boolean)
                .slice(-3)
                .join(' | ')
                .slice(0, 300);
            reject(new Error(`iobroker backup fehlgeschlagen (Exit-Code ${code ?? '?'})${last ? `: ${last}` : ''}`));
        });
    });
}
