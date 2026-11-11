import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunnerFile } from '../runner';
import type { DesiredMessage, JobMessage, JobStep } from './protocol';
import { compareVersions, readJson, writeJsonAtomic } from './util';

/**
 * Command 'adapter' of the fleet management: one version of one adapter right away, for an asset without
 * desired profile (or a self-managed one), like an installation from admin. It runs with the detached runner
 * of the jobs under its own file, so it does not get in the way of a job, and it survives the restart of the
 * agent when the agent updates itself. After such a restart the agent answers from the files.
 */

const ADAPTER_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
/** Longer than the runner needs for one step (30 minutes per call of the CLI, at most two calls) */
export const ADAPTER_COMMAND_TIMEOUT = 65 * 60_000;

/** What the agent remembers about the running command, to answer also after its own restart */
export interface AdapterCommandFile {
    ref: string;
    by: string;
    name: string;
    version: string;
    startedAt: number;
}

export interface AdapterCommandPaths {
    /** RunnerFile of this command */
    runner: string;
    /** AdapterCommandFile */
    command: string;
}

export function adapterCommandPaths(dataDir: string): AdapterCommandPaths {
    return { runner: join(dataDir, 'adapter-runner.json'), command: join(dataDir, 'adapter-command.json') };
}

/**
 * Why the command is refused; null if it may run
 *
 * @param req the request of the server
 * @param desired the desired state the agent has
 */
export function adapterRefusal(req: JobMessage['adapter'], desired: DesiredMessage | null): string | null {
    if (!req || typeof req.name !== 'string' || !ADAPTER_NAME.test(req.name)) {
        return 'Ungültiger Adaptername';
    }
    if (req.name === 'js-controller') {
        return 'js-controller wird nicht über diesen Befehl aktualisiert';
    }
    if (typeof req.version !== 'string' || !VERSION.test(req.version)) {
        return 'Ungültige Version';
    }
    if (desired?.profile && desired.mode === 'managed') {
        // the next job would turn it back
        return 'Die Anlage folgt einem Sollprofil: die Version im Profil ändern oder für diese Anlage festlegen';
    }
    return null;
}

/**
 * The step for the runner: a new adapter with one instance, or an up- or downgrade
 *
 * @param name adapter
 * @param version wanted version
 * @param installed installed version, undefined if the adapter is not installed
 * @param fromPackage from a package of the server: also with the same version number (a build that kept it)
 * @returns null if there is nothing to do
 */
export function adapterStep(
    name: string,
    version: string,
    installed: string | undefined,
    fromPackage: boolean,
): JobStep | null {
    if (!installed) {
        return { action: 'install', adapter: name, from: null, to: version, status: 'pending' };
    }
    const c = compareVersions(version, installed);
    if (c === 0 && !fromPackage) {
        return null;
    }
    return { action: c < 0 ? 'downgrade' : 'upgrade', adapter: name, from: installed, to: version, status: 'pending' };
}

/**
 * Starts the runner for the step, detached from the agent
 *
 * @param paths see adapterCommandPaths
 * @param command what to remember
 * @param step see adapterStep
 * @param opts where and how
 * @param opts.iobrokerJs iobroker.js of js-controller
 * @param opts.cwd directory of ioBroker
 * @param opts.haltFile halt file of the jobs: the emergency stop stops this command too
 * @param opts.logFile log of the runner
 * @param opts.file local package (tgz) instead of npm
 */
export async function startAdapterCommand(
    paths: AdapterCommandPaths,
    command: AdapterCommandFile,
    step: JobStep,
    opts: { iobrokerJs: string; cwd: string; haltFile: string; logFile: string; file?: string },
): Promise<void> {
    const runner: RunnerFile = {
        mode: 'apply',
        steps: [step],
        ...(opts.file ? { files: { [step.adapter!]: opts.file } } : {}),
        iobroker: opts.iobrokerJs,
        cwd: opts.cwd,
        haltFile: opts.haltFile,
        logFile: opts.logFile,
        phase: 'start',
    };
    await writeJsonAtomic(paths.command, command);
    await writeJsonAtomic(paths.runner, runner);
    const child = spawn(process.execPath, [join(__dirname, '..', 'runner.js'), paths.runner], {
        detached: true,
        stdio: 'ignore',
        cwd: opts.cwd,
        windowsHide: true,
    });
    child.unref();
}

/** Outcome of a finished command; null while it runs */
export interface AdapterCommandResult {
    command: AdapterCommandFile;
    state: 'done' | 'error';
    message: string;
}

/**
 * State of the command from its files
 *
 * @param paths see adapterCommandPaths
 * @param now current time, for the timeout
 * @returns undefined without a command, null while it runs, else its outcome
 */
export async function adapterCommandState(
    paths: AdapterCommandPaths,
    now = Date.now(),
): Promise<AdapterCommandResult | null | undefined> {
    const command = await readJson<AdapterCommandFile>(paths.command);
    if (!command) {
        return undefined;
    }
    const runner = await readJson<RunnerFile>(paths.runner);
    const what = `${command.name} ${command.version}`;
    if (runner?.phase === 'done') {
        return { command, state: 'done', message: `${what} installiert` };
    }
    if (runner?.phase === 'failed' || runner?.phase === 'halted') {
        const step = runner.steps[0];
        const reason =
            runner.phase === 'halted'
                ? 'durch Not-Aus angehalten'
                : [runner.error, step?.detail].filter(Boolean).join(': ') || 'fehlgeschlagen';
        return { command, state: 'error', message: `${what}: ${reason}` };
    }
    if (now - command.startedAt > ADAPTER_COMMAND_TIMEOUT) {
        return { command, state: 'error', message: `${what}: keine Rückmeldung des Runners` };
    }
    return null;
}

/** Forgets the command once it is answered */
export async function clearAdapterCommand(paths: AdapterCommandPaths): Promise<void> {
    await rm(paths.command, { force: true });
}
