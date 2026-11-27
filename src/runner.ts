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
import { executeStep, stepMismatch, type StepHost } from './lib/steps';

export { cliArgs, npmArgs } from './lib/steps';

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

/** The calls of the CLI on this host, see steps.ts */
function localHost(file: RunnerFile): StepHost {
    return {
        run: args => run(file, args),
        installed: adapter => Promise.resolve(installedVersion(file, adapter)),
        note: text => appendFileSync(file.logFile, `\n${text}\n`),
    };
}

/**
 * The CLI calls of one step; an adapter that js-controller does not find in its repositories from npm
 *
 * @param file the runner file
 * @param step the step
 */
export async function runStep(file: RunnerFile, step: JobStep): Promise<{ code: number; output: string }> {
    const pkg = step.adapter ? file.files?.[step.adapter] : undefined;
    const { code, output } = await executeStep(step, localHost(file), pkg);
    return { code, output };
}

function run(file: RunnerFile, args: string[]): Promise<{ code: number; output: string }> {
    return new Promise(resolve => {
        const out: string[] = [];
        appendFileSync(file.logFile, `\n[${new Date().toISOString()}] iobroker ${args.join(' ')}\n`);
        const started = Date.now();
        // Node.js kills the CLI itself when it takes too long
        const child = spawn(process.execPath, [file.iobroker, ...args], {
            cwd: file.cwd,
            env: { ...process.env, NODE_ENV: 'production' },
            windowsHide: true,
            timeout: STEP_TIMEOUT,
            killSignal: 'SIGKILL',
        });
        const onData = (d: Buffer): void => {
            const text = d.toString();
            out.push(text);
            appendFileSync(file.logFile, text);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('close', (code, signal) => {
            if (signal === 'SIGKILL' && Date.now() - started >= STEP_TIMEOUT) {
                out.push('\nTimeout, process killed');
            }
            resolve({ code: code ?? 1, output: out.join('') });
        });
        child.on('error', err => resolve({ code: 1, output: err.message }));
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
    return stepMismatch(step, output, step.adapter ? installedVersion(file, step.adapter) : null);
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
