import semver from 'semver';
import { nodeStep } from './node';
import type { DesiredMessage, JobStep } from './protocol';
import { compareVersions } from './util';

/**
 * The planner compares the desired profile with the installed versions.
 * It never touches adapters that are not part of the profile, except those the server
 * explicitly asks to remove (return to managed mode). Own installations of the holder
 * are reported instead; the server decides about the mode.
 */

export type Installed = Record<string, string>;

/** Adapters installed locally that are neither in the profile, tolerated, nor scheduled for removal */
export function foreignAdapters(desired: DesiredMessage, installed: Installed): string[] {
    if (!desired.profile) {
        return [];
    }
    return Object.keys(installed)
        .filter(
            n =>
                !desired.profile!.adapters[n] &&
                !desired.tolerated.includes(n) &&
                !desired.remove.includes(n) &&
                // the controller itself is never an adapter of the profile
                n !== 'js-controller',
        )
        .sort();
}

/**
 * Steps to reach the profile. Node.js comes first, the agent (bee) always last.
 *
 * @param desired desired state of the server
 * @param installed installed versions
 * @param selfName name of the agent adapter
 * @param from where the adapters were installed from (installedFrom); with a package of the server and the
 *     same version installed from somewhere else, the package is installed once more (a build that kept
 *     the version number). Only given as long as that was not tried yet for this job.
 * @param node the running Node.js (process.version); with it a step to the major line of the profile
 */
export function computePlan(
    desired: DesiredMessage,
    installed: Installed,
    selfName = 'bee',
    from?: Record<string, string | undefined>,
    node?: string,
): JobStep[] {
    const steps: JobStep[] = [];
    if (!desired.profile) {
        return steps;
    }
    for (const [name, target] of Object.entries(desired.profile.adapters)) {
        const current = installed[name];
        const source = from?.[name];
        const otherBuild = !!target.tarball && !!source && !source.includes(target.tarball.sha256);
        if (current === target.version && !otherBuild) {
            continue;
        }
        steps.push({
            action: !current
                ? 'install'
                : current === target.version || compareVersions(current, target.version) < 0
                  ? 'upgrade'
                  : 'downgrade',
            adapter: name,
            from: current ?? null,
            to: target.version,
            status: 'pending',
        });
    }
    for (const name of desired.remove) {
        if (installed[name] && name !== selfName) {
            steps.push({ action: 'remove', adapter: name, from: installed[name], to: null, status: 'pending' });
        }
    }
    // removals first (frees space), then installs/updates alphabetically, the agent last
    const rank = (s: JobStep): number => (s.adapter === selfName ? 2 : s.action === 'remove' ? 0 : 1);
    steps.sort((a, b) => rank(a) - rank(b) || a.adapter!.localeCompare(b.adapter!));
    // Node.js before everything else: the new versions may need it
    const step = node ? nodeStep(desired.profile.node, node) : null;
    return step ? [step, ...steps] : steps;
}

/** Steps that restore the previous state after a failed rollout (reverse order); Node.js stays */
export function rollbackPlan(steps: JobStep[]): JobStep[] {
    return steps
        .filter(s => s.action !== 'backup' && s.action !== 'node' && s.status === 'ok')
        .reverse()
        .map(s => {
            if (s.action === 'install') {
                return { action: 'remove', adapter: s.adapter, from: s.to, to: null, status: 'pending' };
            }
            if (s.action === 'remove') {
                return { action: 'install', adapter: s.adapter, from: null, to: s.from, status: 'pending' };
            }
            return {
                action: s.action === 'upgrade' ? 'downgrade' : 'upgrade',
                adapter: s.adapter,
                from: s.to,
                to: s.from,
                status: 'pending',
            };
        });
}

/**
 * Checks the dependencies of all target versions against the state after the plan
 * (io-package.json dependencies, globalDependencies and engines.node of the target version).
 *
 * @param desired desired state of the server
 * @param installed installed versions
 * @param env versions on the system
 * @param env.jsController installed js-controller
 * @param env.node running Node.js
 * @param env.nodeMajor the major line the plan brings Node.js to before the adapters
 * @returns list of violations; empty if everything fits
 */
export function checkDependencies(
    desired: DesiredMessage,
    installed: Installed,
    env: { jsController: string; node: string; nodeMajor?: number },
): string[] {
    const errors: string[] = [];
    if (!desired.profile) {
        return errors;
    }
    const after: Installed = { ...installed };
    for (const name of desired.remove) {
        delete after[name];
    }
    for (const [name, a] of Object.entries(desired.profile.adapters)) {
        after[name] = a.version;
    }
    for (const [name, a] of Object.entries(desired.profile.adapters)) {
        if (installed[name] === a.version) {
            continue;
        }
        if (a.node && semver.validRange(a.node)) {
            if (env.nodeMajor) {
                if (!semver.intersects(a.node, `^${env.nodeMajor}.0.0`)) {
                    errors.push(`${name}@${a.version} verlangt Node ${a.node}, geplant ist Node ${env.nodeMajor}`);
                }
            } else if (!semver.satisfies(env.node, a.node)) {
                errors.push(`${name}@${a.version} verlangt Node ${a.node}, installiert ist ${env.node}`);
            }
        }
        for (const dep of [...(a.dependencies || []), ...(a.globalDependencies || [])]) {
            for (const [depName, range] of Object.entries(dep)) {
                const have = depName === 'js-controller' ? env.jsController : after[depName];
                if (!have) {
                    errors.push(`${name}@${a.version} braucht ${depName} ${range}, das fehlt`);
                } else if (semver.validRange(range) && !semver.satisfies(have, range, { includePrerelease: true })) {
                    errors.push(`${name}@${a.version} braucht ${depName} ${range}, vorhanden ist ${have}`);
                }
            }
        }
    }
    return errors;
}
