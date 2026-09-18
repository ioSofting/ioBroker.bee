import semver from 'semver';
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

/** Steps to reach the profile. The agent (bee) is always updated last. */
export function computePlan(desired: DesiredMessage, installed: Installed, selfName = 'bee'): JobStep[] {
    const steps: JobStep[] = [];
    if (!desired.profile) {
        return steps;
    }
    for (const [name, target] of Object.entries(desired.profile.adapters)) {
        const current = installed[name];
        if (current === target.version) {
            continue;
        }
        steps.push({
            action: !current ? 'install' : compareVersions(current, target.version) < 0 ? 'upgrade' : 'downgrade',
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
    return steps.sort((a, b) => rank(a) - rank(b) || a.adapter!.localeCompare(b.adapter!));
}

/** Steps that restore the previous state after a failed rollout (reverse order) */
export function rollbackPlan(steps: JobStep[]): JobStep[] {
    return steps
        .filter(s => s.action !== 'backup' && s.status === 'ok')
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
 * @returns list of violations; empty if everything fits
 */
export function checkDependencies(
    desired: DesiredMessage,
    installed: Installed,
    env: { jsController: string; node: string },
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
        if (a.node && semver.validRange(a.node) && !semver.satisfies(env.node, a.node)) {
            errors.push(`${name}@${a.version} verlangt Node ${a.node}, installiert ist ${env.node}`);
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
