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
    phase: 'start' | 'running' | 'done' | 'failed' | 'halted';
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

export function cliArgs(step: JobStep): string[] {
    switch (step.action) {
        case 'backup':
            return ['backup'];
        case 'install':
            // installs the package and creates one instance
            return ['add', `${step.adapter}@${step.to}`];
        case 'upgrade':
            return ['upgrade', `${step.adapter}@${step.to}`, '--yes'];
        case 'downgrade':
            return ['upgrade', `${step.adapter}@${step.to}`, '--yes', '--force'];
        case 'remove':
            return ['del', step.adapter!];
    }
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

function checkResult(file: RunnerFile, step: JobStep): string | null {
    if (step.action === 'backup' || !step.adapter) {
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
        step.status = 'running';
        step.ts = Date.now();
        save(path, file);
        const result = await run(file, cliArgs(step));
        const mismatch = result.code === 0 ? checkResult(file, step) : null;
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
                ? `${step.action} ${step.adapter}: ${mismatch}`
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
