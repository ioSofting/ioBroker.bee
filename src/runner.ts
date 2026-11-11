/**
 * Detached job runner. Started by the adapter as an independent process, it executes the
 * steps of a job with the ioBroker CLI and survives restarts of the adapter, including
 * the update of the agent itself (the same pattern admin uses for its self-update).
 *
 * Usage: node runner.js <runner.json>
 * The runner owns runner.json while it runs; the adapter only reads it.
 * No dependencies besides Node.js built-ins.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobStep } from './lib/protocol';

export interface RunnerFile {
    mode: 'apply' | 'rollback';
    steps: JobStep[];
    /** Path to iobroker.js of the js-controller */
    iobroker: string;
    cwd: string;
    /** If this file exists, no further step is started (emergency stop) */
    haltFile: string;
    logFile: string;
    /** Packages of the fleet server per adapter (local tgz) instead of npm; only when applying */
    files?: Record<string, string>;
    /** node: stopped at the step for Node.js, the adapter does that one and starts the runner again */
    phase: 'start' | 'running' | 'done' | 'failed' | 'halted' | 'node';
    pid?: number;
    error?: string;
    startedAt?: number;
    finishedAt?: number;
}

const STEP_TIMEOUT = 30 * 60_000;

function save(file: string, data: RunnerFile): void {
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${file}.tmp`, file);
}

/**
 * Calls of the CLI for one step, one after the other
 *
 * @param step step of the job
 * @param file local package (tgz) to install from instead of npm
 */
export function cliArgs(step: JobStep, file?: string): string[][] {
    if (file && step.adapter && step.action !== 'remove' && step.action !== 'backup') {
        // the name is given: it cannot be taken from the file name <sha256>.tgz
        const url = ['url', file, step.adapter];
        // "url" only installs the package; "add" then creates the instance from it, without npm
        return step.action === 'install' ? [url, ['add', step.adapter]] : [url];
    }
    switch (step.action) {
        case 'backup':
            return [['backup']];
        case 'node':
            // not with the CLI, see node.ts
            return [];
        case 'install':
            // installs the package and creates one instance
            return [['add', `${step.adapter}@${step.to}`]];
        case 'upgrade':
            return [['upgrade', `${step.adapter}@${step.to}`, '--yes']];
        case 'downgrade':
            return [['upgrade', `${step.adapter}@${step.to}`, '--yes', '--force']];
        case 'remove':
            return [['del', step.adapter!]];
        case 'addInstance':
            // with the number: "add" only creates the instance, the adapter is installed already
            return [['add', step.adapter!, step.instance!.slice(step.adapter!.length + 1)]];
        case 'removeInstance':
            return [['del', step.instance!]];
    }
}

/**
 * js-controller installs and upgrades only adapters of its repositories ("is not in the repository", "Unknown packet
 * name"). An adapter only on npm, like bee itself or an own adapter, it installs as admin does: with "url".
 */
const NOT_IN_REPO = /is not in the repository|Unknown packet name/i;

/**
 * The same step from npm, for an adapter that is not in the repositories of the system; null if there is none
 *
 * @param step step of the job
 */
export function npmArgs(step: JobStep): string[][] | null {
    if (!step.adapter || !step.to || !['install', 'upgrade', 'downgrade'].includes(step.action)) {
        return null;
    }
    const url = ['url', `iobroker.${step.adapter}@${step.to}`, step.adapter];
    // "url" only installs the package; "add" then creates the instance from it
    return step.action === 'install' ? [url, ['add', step.adapter]] : [url];
}

async function runAll(file: RunnerFile, calls: string[][]): Promise<{ code: number; output: string }> {
    let result = { code: 0, output: '' };
    for (const args of calls) {
        const r = await run(file, args);
        result = { code: r.code, output: result.output + r.output };
        if (r.code !== 0) {
            break;
        }
    }
    return result;
}

/**
 * The CLI calls of one step; an adapter that js-controller does not find in its repositories from npm
 *
 * @param file the runner file
 * @param step the step
 */
export async function runStep(file: RunnerFile, step: JobStep): Promise<{ code: number; output: string }> {
    const pkg = step.adapter ? file.files?.[step.adapter] : undefined;
    const result = await runAll(file, cliArgs(step, pkg));
    const alt = pkg ? null : npmArgs(step);
    const failed = result.code !== 0 || checkResult(file, step, result.output) !== null;
    if (alt && failed && NOT_IN_REPO.test(result.output)) {
        appendFileSync(
            file.logFile,
            `\n[npm] ${step.adapter} is not in the repositories of this system: from npm, as admin installs it\n`,
        );
        const r = await runAll(file, alt);
        return { code: r.code, output: result.output + r.output };
    }
    return result;
}

function run(file: RunnerFile, args: string[]): Promise<{ code: number; output: string }> {
    return new Promise(resolve => {
        const out: string[] = [];
        appendFileSync(file.logFile, `\n[${new Date().toISOString()}] iobroker ${args.join(' ')}\n`);
        const child = spawn(process.execPath, [file.iobroker, ...args], {
            cwd: file.cwd,
            env: { ...process.env, NODE_ENV: 'production' },
            windowsHide: true,
        });
        const onData = (d: Buffer): void => {
            const text = d.toString();
            out.push(text);
            appendFileSync(file.logFile, text);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        const timer = setTimeout(() => {
            out.push('\nTimeout, process killed');
            child.kill('SIGKILL');
        }, STEP_TIMEOUT);
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code: code ?? 1, output: out.join('') });
        });
        child.on('error', err => {
            clearTimeout(timer);
            resolve({ code: 1, output: err.message });
        });
    });
}

/**
 * The CLI may exit with 0 without having changed anything (e.g. unknown version).
 * Check what is really installed in node_modules afterwards.
 */
function installedVersion(file: RunnerFile, adapter: string): string | null {
    try {
        const pkg = JSON.parse(
            readFileSync(join(file.cwd, 'node_modules', `iobroker.${adapter}`, 'package.json'), 'utf8'),
        );
        return typeof pkg.version === 'string' ? pkg.version : null;
    } catch {
        return null;
    }
}

/**
 * Why the step did not do what it should although the CLI ended with 0, or null
 *
 * @param file the runner file
 * @param step the step
 * @param output what the CLI printed
 */
export function checkResult(file: RunnerFile, step: JobStep, output: string): string | null {
    if (step.action === 'removeInstance') {
        // js-controller keeps an instance others depend on, and still ends with 0
        const refused = /Cannot remove instance[^\r\n]*/.exec(output);
        return refused ? refused[0].trim() : null;
    }
    if (step.action === 'backup' || step.action === 'addInstance' || !step.adapter) {
        return null;
    }
    const version = installedVersion(file, step.adapter);
    if (step.action === 'remove') {
        return version ? `${step.adapter} ist nach dem Entfernen noch installiert (${version})` : null;
    }
    return version === step.to ? null : `installiert ist ${version ?? 'nichts'} statt ${step.to}`;
}

function tail(text: string, lines = 6): string {
    return text
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .slice(-lines)
        .join(' | ')
        .slice(0, 800);
}

async function main(path: string): Promise<void> {
    const file = JSON.parse(readFileSync(path, 'utf8')) as RunnerFile;
    file.pid = process.pid;
    file.phase = 'running';
    file.startedAt = Date.now();
    save(path, file);

    for (const step of file.steps) {
        if (step.status !== 'pending') {
            continue;
        }
        if (file.mode === 'apply' && step.action !== 'backup' && existsSync(file.haltFile)) {
            file.phase = 'halted';
            file.steps.filter(s => s.status === 'pending').forEach(s => (s.status = 'skipped'));
            break;
        }
        if (step.action === 'node') {
            // it stops ioBroker: the adapter runs it as root and starts the runner again for the rest
            file.phase = 'node';
            break;
        }
        step.status = 'running';
        step.ts = Date.now();
        save(path, file);
        const result = await runStep(file, step);
        const mismatch = result.code === 0 ? checkResult(file, step, result.output) : null;
        if (mismatch) {
            appendFileSync(file.logFile, `\n[check] ${mismatch}\n`);
            result.code = 1;
            result.output += `\n${mismatch}`;
        }
        if (result.code === 0) {
            step.status = 'ok';
            if (step.action === 'backup') {
                const m = /Backup created: (.+)$/m.exec(result.output);
                step.detail = m ? m[1].trim() : undefined;
                if (step.detail) {
                    try {
                        step.detail = `${step.detail} (${Math.round(statSync(step.detail).size / 1024 / 1024)} MB)`;
                    } catch {
                        // size unknown
                    }
                }
            }
        } else {
            step.status = 'error';
            step.detail = tail(result.output);
            file.phase = 'failed';
            file.error = mismatch
                ? `${step.action} ${step.instance ?? step.adapter}: ${mismatch}`
                : `${step.action}${step.adapter ? ` ${step.adapter}` : ''} fehlgeschlagen (Exit-Code ${result.code})`;
            file.steps.filter(s => s.status === 'pending').forEach(s => (s.status = 'skipped'));
        }
        save(path, file);
        if (file.phase === 'failed') {
            break;
        }
    }
    if (file.phase === 'running') {
        file.phase = 'done';
    }
    file.finishedAt = Date.now();
    save(path, file);
}

if (require.main === module) {
    const path = process.argv[2];
    main(path).catch(e => {
        try {
            const file = JSON.parse(readFileSync(path, 'utf8')) as RunnerFile;
            file.phase = 'failed';
            file.error = `Runner: ${e.message}`;
            file.finishedAt = Date.now();
            save(path, file);
        } catch {
            // nothing left to report to
        }
        process.exit(1);
    });
}
