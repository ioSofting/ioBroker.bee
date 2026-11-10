import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import type { DesiredMessage, JobStep, ProfileAdapter } from './protocol';

/**
 * Adapter packages (tgz) the fleet server hands out for single assets instead of npm. The agent loads
 * them only from its own server, checks the SHA-256 and keeps them: npm notes the file in the
 * package.json of ioBroker ("file:…"), a later npm install needs it again.
 */

export type Tarball = NonNullable<ProfileAdapter['tarball']>;

/** Largest package that is loaded (the server accepts no larger ones) */
export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

/** Is the URL one of our own server? https, or http on this computer only (development) */
export function trustedPackageUrl(url: string, serverUrls: string[]): boolean {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
        return false;
    }
    return serverUrls.some(s => {
        try {
            return new URL(s).hostname === u.hostname;
        } catch {
            return false;
        }
    });
}

/** Steps of the plan that install from a package of the server: adapter -> package */
export function packagesOf(desired: DesiredMessage, steps: JobStep[]): Record<string, Tarball> {
    const result: Record<string, Tarball> = {};
    for (const s of steps) {
        const tarball = s.adapter && s.action !== 'remove' ? desired.profile?.adapters[s.adapter]?.tarball : undefined;
        if (tarball) {
            result[s.adapter!] = tarball;
        }
    }
    return result;
}

export function packageFile(dir: string, sha256: string): string {
    return join(dir, `${sha256}.tgz`);
}

function hashFile(file: string): Promise<string | null> {
    return new Promise(resolve => {
        const hash = createHash('sha256');
        createReadStream(file)
            .on('data', d => hash.update(d))
            .on('end', () => resolve(hash.digest('hex')))
            .on('error', () => resolve(null));
    });
}

function download(url: string, target: string, maxBytes: number, ca: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const get = u.protocol === 'https:' ? https.get : http.get;
        const req = get(url, { ca, timeout: 60_000 }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const hash = createHash('sha256');
            const out = createWriteStream(target);
            let size = 0;
            let failed = false;
            const fail = (e: Error): void => {
                if (!failed) {
                    failed = true;
                    res.unpipe(out);
                    res.destroy();
                    out.destroy();
                    reject(e);
                }
            };
            res.on('data', (d: Buffer) => {
                size += d.length;
                if (size > maxBytes) {
                    fail(new Error('größer als angekündigt'));
                    return;
                }
                hash.update(d);
            });
            res.pipe(out);
            res.on('error', fail);
            out.on('error', fail);
            out.on('finish', () => !failed && resolve(hash.digest('hex')));
        });
        req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
        req.on('error', reject);
    });
}

/**
 * Path of the package on this device; loads it from the server if it is not here yet.
 *
 * @param dir directory of the packages (stays, see above)
 * @param tarball package from the desired state
 * @param opts URLs of the own server and the trusted CAs
 * @param opts.serverUrls URLs of the own server (enrollment and broker)
 * @param opts.ca trusted CAs for the server certificate
 */
export async function ensurePackage(
    dir: string,
    tarball: Tarball,
    opts: { serverUrls: string[]; ca: string[] },
): Promise<string> {
    if (!/^[0-9a-f]{64}$/.test(tarball.sha256)) {
        throw new Error('ungültige Prüfsumme');
    }
    const file = packageFile(dir, tarball.sha256);
    if ((await hashFile(file)) === tarball.sha256) {
        return file;
    }
    if (!trustedPackageUrl(tarball.url, opts.serverUrls)) {
        throw new Error(`${tarball.url} gehört nicht zum Flottenserver`);
    }
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.part`;
    try {
        const sha = await download(
            tarball.url,
            tmp,
            Math.min(tarball.size || MAX_PACKAGE_BYTES, MAX_PACKAGE_BYTES),
            opts.ca,
        );
        if (sha !== tarball.sha256) {
            throw new Error('Prüfsumme stimmt nicht');
        }
        await rename(tmp, file);
        return file;
    } finally {
        // on Windows the file may still be open for a moment after an abort: then it is overwritten next time
        await rm(tmp, { force: true }).catch(() => {});
    }
}
