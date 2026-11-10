import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DesiredMessage, JobState, JobStep } from './protocol';
import { rollbackPlan } from './planner';
import type { RunnerFile } from '../runner';
import { readJson, writeJsonAtomic } from './util';

/**
 * Job lifecycle on the installation: backup -> rollout -> verify -> done, or rollback -> blocked.
 * The job is persisted, so a restart of the adapter (e.g. during its own update) continues
 * where it left off. The actual CLI work runs in the detached runner.
 */

export type JobPhase = 'apply' | 'verify' | 'rollback' | 'finished';

export interface JobFile {
    key: string;
    profileId: string;
    profileName: string;
    profileHash: string;
    retry: number;
    targets: Record<string, string | null>;
    state: JobState;
    detail: string;
    steps: JobStep[];
    phase: JobPhase;
    createdAt: number;
    verifyStartedAt?: number;
    failure?: string;
    /** Rollback was caused by the emergency stop: wait instead of blocking */
    halted?: boolean;
}

export interface JobDeps {
    dataDir: string;
    iobrokerJs: string;
    cwd: string;
    log: ioBroker.Logger;
    verifySeconds: number;
    startTimeoutSeconds: number;
    report: (job: JobFile) => Promise<void>;
    installed: () => Promise<Record<string, string>>;
    /** enabled instances of an adapter and whether they are alive */
    instancesOf: (adapter: string) => Promise<{ id: string; alive: boolean }[]>;
    /** error log lines of the given adapters since ts */
    errorsSince: (ts: number, adapters: string[]) => { from: string; message: string }[];
    onFinished: (job: JobFile, result: 'done' | 'blocked' | 'waiting') => Promise<void>;
}

function pidAlive(pid: number | undefined): boolean {
    if (!pid) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

export class JobManager {
    job: JobFile | null = null;
    private readonly jobFile: string;
    private readonly runnerFile: string;
    readonly haltFile: string;
    private busy = false;

    constructor(private readonly deps: JobDeps) {
        this.jobFile = join(deps.dataDir, 'job.json');
        this.runnerFile = join(deps.dataDir, 'runner.json');
        this.haltFile = join(deps.dataDir, 'halt');
    }

    async load(): Promise<void> {
        this.job = await readJson<JobFile>(this.jobFile);
        if (this.job?.phase === 'finished') {
            this.job = null;
        }
    }

    isActive(): boolean {
        return !!this.job && this.job.phase !== 'finished';
    }

    private async save(): Promise<void> {
        if (this.job) {
            await writeJsonAtomic(this.jobFile, this.job);
        }
    }

    private async setState(state: JobState, detail: string): Promise<void> {
        if (!this.job) {
            return;
        }
        const changed = this.job.state !== state || this.job.detail !== detail;
        this.job.state = state;
        this.job.detail = detail;
        await this.save();
        if (changed) {
            await this.deps.report(this.job);
        }
    }

    async setHalt(halt: boolean): Promise<void> {
        if (halt) {
            await writeJsonAtomic(this.haltFile, { ts: Date.now() });
        } else {
            await rm(this.haltFile, { force: true });
        }
    }

    private async spawnRunner(
        mode: RunnerFile['mode'],
        steps: JobStep[],
        files?: Record<string, string>,
    ): Promise<void> {
        const file: RunnerFile = {
            mode,
            steps,
            ...(files && Object.keys(files).length ? { files } : {}),
            iobroker: this.deps.iobrokerJs,
            cwd: this.deps.cwd,
            haltFile: this.haltFile,
            logFile: join(this.deps.dataDir, 'runner.log'),
            phase: 'start',
        };
        await writeJsonAtomic(this.runnerFile, file);
        const child = spawn(process.execPath, [join(__dirname, '..', 'runner.js'), this.runnerFile], {
            detached: true,
            stdio: 'ignore',
            cwd: this.deps.cwd,
            windowsHide: true,
        });
        child.unref();
        this.deps.log.info(`Runner started (${mode}, ${steps.length} steps, pid ${child.pid})`);
    }

    /**
     * Starts a job
     *
     * @param desired desired state
     * @param steps plan
     * @param withBackup backup first
     * @param files local packages per adapter instead of npm (the rollback takes npm)
     */
    async start(
        desired: DesiredMessage,
        steps: JobStep[],
        withBackup: boolean,
        files: Record<string, string> = {},
    ): Promise<void> {
        const profile = desired.profile!;
        const all: JobStep[] = withBackup ? [{ action: 'backup', status: 'pending' }, ...steps] : steps;
        this.job = {
            key: `${profile.hash}:${desired.retry}`,
            profileId: profile.id,
            profileName: profile.name,
            profileHash: profile.hash,
            retry: desired.retry,
            targets: Object.fromEntries(steps.map(s => [s.adapter!, s.to ?? null])),
            state: 'preflight',
            detail: '',
            steps: all,
            phase: 'apply',
            createdAt: Date.now(),
        };
        await this.save();
        await this.spawnRunner('apply', all, files);
        await this.setState(withBackup ? 'backup' : 'rollout', withBackup ? 'Sicherung wird erstellt' : 'Ausrollen');
    }

    /** Called periodically while a job is active */
    async poll(): Promise<void> {
        if (!this.job || this.busy) {
            return;
        }
        this.busy = true;
        try {
            if (this.job.phase === 'apply' || this.job.phase === 'rollback') {
                await this.pollRunner();
            } else if (this.job.phase === 'verify') {
                await this.verify();
            }
        } catch (e) {
            this.deps.log.error(`Job: ${e.stack || e.message}`);
        } finally {
            this.busy = false;
        }
    }

    private async pollRunner(): Promise<void> {
        const job = this.job!;
        const runner = await readJson<RunnerFile>(this.runnerFile);
        if (!runner) {
            return;
        }
        const finished = runner.phase === 'done' || runner.phase === 'failed' || runner.phase === 'halted';
        if (!finished && runner.phase === 'running' && !pidAlive(runner.pid)) {
            // runner died (power loss, reboot)
            runner.phase = 'failed';
            runner.error = 'Ausführung wurde unterbrochen (Neustart oder Stromausfall)';
        } else if (!finished) {
            if (job.phase === 'apply') {
                job.steps = runner.steps;
                const current = runner.steps.find(s => s.status === 'running');
                if (current?.action === 'backup') {
                    await this.setState('backup', 'Sicherung wird erstellt');
                } else if (current) {
                    await this.setState('rollout', `${current.action} ${current.adapter} ${current.to ?? ''}`.trim());
                }
            }
            return;
        }

        if (job.phase === 'apply') {
            job.steps = runner.steps;
            if (runner.phase === 'done') {
                job.phase = 'verify';
                job.verifyStartedAt = Date.now();
                await this.setState('verify', 'Instanzen und Log werden geprüft');
            } else {
                await this.startRollback(
                    runner.phase === 'halted' ? 'Not-Aus während des Rollouts' : runner.error || 'Fehler',
                    runner.phase === 'halted',
                );
            }
            return;
        }
        // rollback finished
        const ok = runner.phase === 'done';
        const detail = `${job.failure}; ${ok ? 'vorheriger Stand wiederhergestellt' : `Rollback unvollständig (${runner.error}), Sicherung vorhanden`}`;
        for (const s of runner.steps) {
            const original = job.steps.find(o => o.adapter === s.adapter && o.status === 'ok');
            if (original) {
                original.status = s.status === 'ok' ? 'skipped' : 'error';
                original.detail = s.status === 'ok' ? 'zurückgerollt' : `Rollback: ${s.detail || 'fehlgeschlagen'}`;
            }
        }
        await this.finish(job.halted && ok ? 'waiting' : 'blocked', detail);
    }

    private async startRollback(reason: string, halted = false): Promise<void> {
        const job = this.job!;
        job.failure = reason;
        job.halted = halted;
        const steps = rollbackPlan(job.steps);
        if (!steps.length) {
            await this.finish(halted ? 'waiting' : 'blocked', `${reason}; keine Änderung erfolgt`);
            return;
        }
        job.phase = 'rollback';
        await this.save();
        await this.spawnRunner('rollback', steps);
        await this.setState('rollback', reason);
    }

    private async verify(): Promise<void> {
        const job = this.job!;
        const elapsed = (Date.now() - (job.verifyStartedAt ?? Date.now())) / 1000;
        const installed = await this.deps.installed();
        for (const [name, version] of Object.entries(job.targets)) {
            if ((installed[name] ?? null) !== version) {
                await this.startRollback(
                    `${name}: installiert ${installed[name] ?? 'nichts'}, erwartet ${version ?? 'entfernt'}`,
                );
                return;
            }
        }
        const changed = Object.entries(job.targets)
            .filter(([, v]) => v)
            .map(([n]) => n);
        const errors = this.deps.errorsSince(job.verifyStartedAt!, changed);
        if (errors.length) {
            await this.startRollback(`Fehler im Log von ${errors[0].from}: ${errors[0].message.slice(0, 200)}`);
            return;
        }
        const down: string[] = [];
        for (const name of changed) {
            for (const inst of await this.deps.instancesOf(name)) {
                if (!inst.alive) {
                    down.push(inst.id);
                }
            }
        }
        if (down.length) {
            if (elapsed > this.deps.startTimeoutSeconds) {
                await this.startRollback(`Instanz ${down.join(', ')} startet nach dem Update nicht`);
            }
            return;
        }
        if (elapsed >= this.deps.verifySeconds) {
            const n = job.steps.filter(s => s.action !== 'backup').length;
            await this.finish('done', `${n} Schritte erfolgreich, Instanzen laufen, keine neuen Fehler im Log`);
        }
    }

    private async finish(result: 'done' | 'blocked' | 'waiting', detail: string): Promise<void> {
        const job = this.job!;
        job.phase = 'finished';
        await this.setState(result === 'waiting' ? 'waiting' : result, detail);
        await this.deps.onFinished(job, result);
        this.job = null;
        if (existsSync(this.runnerFile)) {
            await rm(this.runnerFile, { force: true });
        }
    }
}
