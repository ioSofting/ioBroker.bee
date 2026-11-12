import type { JobStep } from './protocol';

/**
 * The calls of the ioBroker CLI for a step and how to judge their outcome. Used by the detached runner on the host of
 * the agent and for the other hosts of the system, where js-controller runs the same calls (host command cmdExec).
 * No dependencies besides types: the runner has none.
 */

/** Outcome of calls of the CLI */
export interface CallResult {
    code: number;
    output: string;
}

/**
 * Calls of the CLI for one step, one after the other
 *
 * @param step step of the job
 * @param file local package (tgz) to install from instead of npm; on another host the name it is sent with
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
export const NOT_IN_REPO = /is not in the repository|Unknown packet name/i;

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

/**
 * Runs the calls one after the other, until one fails
 *
 * @param calls see cliArgs
 * @param run runs one call of the CLI
 */
export async function runCalls(calls: string[][], run: (args: string[]) => Promise<CallResult>): Promise<CallResult> {
    let result = { code: 0, output: '' };
    for (const args of calls) {
        const r = await run(args);
        result = { code: r.code, output: result.output + r.output };
        if (r.code !== 0) {
            break;
        }
    }
    return result;
}

/**
 * Why the step did not do what it should although the CLI ended with 0, or null
 *
 * @param step the step
 * @param output what the CLI printed
 * @param version the version of the adapter installed now (null: none), read after the calls
 */
export function stepMismatch(step: JobStep, output: string, version: string | null): string | null {
    if (step.action === 'removeInstance') {
        // js-controller keeps an instance others depend on, and still ends with 0
        const refused = /Cannot remove instance[^\r\n]*/.exec(output);
        return refused ? refused[0].trim() : null;
    }
    if (step.action === 'backup' || step.action === 'addInstance' || !step.adapter) {
        return null;
    }
    if (step.action === 'remove') {
        return version ? `${step.adapter} ist nach dem Entfernen noch installiert (${version})` : null;
    }
    return version === step.to ? null : `installiert ist ${version ?? 'nichts'} statt ${step.to}`;
}

/** Where a step runs: the CLI, and what is installed afterwards */
export interface StepHost {
    /** Runs one call of the CLI */
    run(args: string[]): Promise<CallResult>;
    /** Version of the adapter installed now, null if none */
    installed(adapter: string): Promise<string | null>;
    /** A line for the log of the step */
    note(text: string): void;
}

/**
 * The CLI calls of one step; an adapter that js-controller does not find in its repositories from npm. The result
 * carries the mismatch of a call that ended with 0 without doing what it should.
 *
 * @param step the step
 * @param host where it runs
 * @param pkg local package (tgz) instead of npm, see cliArgs
 */
export async function executeStep(
    step: JobStep,
    host: StepHost,
    pkg?: string,
): Promise<CallResult & { mismatch: string | null }> {
    const needsVersion = (): boolean =>
        !!step.adapter && !['backup', 'addInstance', 'removeInstance'].includes(step.action);
    const check = async (r: CallResult): Promise<string | null> =>
        r.code === 0 ? stepMismatch(step, r.output, needsVersion() ? await host.installed(step.adapter!) : null) : null;

    let result = await runCalls(cliArgs(step, pkg), args => host.run(args));
    let mismatch = await check(result);
    const alt = pkg ? null : npmArgs(step);
    if (alt && (result.code !== 0 || mismatch) && NOT_IN_REPO.test(result.output)) {
        host.note(`[npm] ${step.adapter} is not in the repositories of this system: from npm, as admin installs it`);
        const r = await runCalls(alt, args => host.run(args));
        result = { code: r.code, output: result.output + r.output };
        mismatch = await check(r);
    }
    return { ...result, mismatch };
}
