import { gunzipSync, gzipSync } from 'node:zlib';
import { rename, writeFile, readFile } from 'node:fs/promises';
import semver from 'semver';

export function encodePayload(obj: unknown): Buffer {
    return gzipSync(Buffer.from(JSON.stringify(obj)));
}

export function decodePayload<T>(buf: Buffer): T {
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        buf = gunzipSync(buf);
    }
    return JSON.parse(buf.toString('utf8')) as T;
}

/**
 * Compares two versions. Non-semver strings are compared lexically.
 *
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
export function compareVersions(a: string, b: string): number {
    const va = semver.valid(a) ?? semver.coerce(a)?.version;
    const vb = semver.valid(b) ?? semver.coerce(b)?.version;
    if (va && vb) {
        return semver.compare(va, vb);
    }
    return a.localeCompare(b);
}

function escapeKey(key: string): string {
    return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Flattens an object to JSON pointer paths (same format as the server) */
export function flatten(obj: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length) {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            flatten(v, `${prefix}/${escapeKey(k)}`, out);
        }
    } else {
        out[prefix] = obj;
    }
    return out;
}

export function diffFlat(
    prev: Record<string, unknown>,
    next: Record<string, unknown>,
): { set: Record<string, unknown>; unset: string[] } {
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const [k, v] of Object.entries(next)) {
        if (!(k in prev) || JSON.stringify(prev[k]) !== JSON.stringify(v)) {
            set[k] = v;
        }
    }
    for (const k of Object.keys(prev)) {
        if (!(k in next)) {
            unset.push(k);
        }
    }
    return { set, unset };
}

/** Writes JSON atomically (temp file + rename), so a power loss never leaves half a file */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

/** "HH:MM" -> minutes since midnight */
function minutes(hhmm: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

/** True if `date` lies in the daily window [start, end). Windows may span midnight (22:00-05:00). */
export function inWindow(date: Date, start: string, end: string): boolean {
    const s = minutes(start);
    const e = minutes(end);
    if (s === null || e === null || s === e) {
        return true;
    }
    const now = date.getHours() * 60 + date.getMinutes();
    return s < e ? now >= s && now < e : now >= s || now < e;
}

/**
 * Timers of the adapter: js-controller clears them when the adapter stops, so nothing fires into an
 * adapter that is gone. While it stops, setTimeout and setInterval give undefined and start nothing.
 * The modules get them from the adapter, the tests those of Node.js.
 */
export type Timers = Pick<ioBroker.Adapter, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'>;
