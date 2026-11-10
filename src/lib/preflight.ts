import { statfs } from 'node:fs/promises';
import { inWindow } from './util';

/**
 * Preflight decides between "run now", "wait" (conditions that will change by themselves:
 * maintenance window, installation in use, battery low, roaming) and "blocked" (needs a human:
 * dependencies, disk full).
 */

export type Operator = '==' | '!=' | '<' | '<=' | '>' | '>=';

/** A condition on an ioBroker state, configured in the adapter, e.g. "victron.0.soc >= 50" */
export interface Condition {
    stateId: string;
    op: Operator;
    value: string;
    label?: string;
}

export interface PreflightInput {
    now: Date;
    halted: boolean;
    haltReason?: string;
    window: { start: string; end: string; ignore: boolean };
    conditions: Condition[];
    readState: (id: string) => Promise<ioBroker.StateValue | undefined>;
    diskPath: string;
    minFreeMb: number;
    dependencyErrors: string[];
    /** Why Node.js cannot be updated, if the plan has a step for it */
    nodeErrors?: { target: string; errors: string[] };
}

export type PreflightResult = { ok: true } | { ok: false; kind: 'wait' | 'block'; reason: string };

function coerce(value: string): string | number | boolean {
    const v = value.trim();
    if (v === 'true' || v === 'false') {
        return v === 'true';
    }
    if (v !== '' && !isNaN(Number(v))) {
        return Number(v);
    }
    return v;
}

export function compare(actual: ioBroker.StateValue, op: Operator, expected: string): boolean {
    const exp = coerce(expected);
    let act: unknown = actual;
    if (typeof exp === 'number' && typeof actual === 'string' && !isNaN(Number(actual))) {
        act = Number(actual);
    }
    if (typeof exp === 'boolean' && typeof actual !== 'boolean') {
        act = actual === 'true' || actual === 1 || actual === '1';
    }
    switch (op) {
        case '==':
            return act == exp;
        case '!=':
            return act != exp;
        case '<':
            return Number(act) < Number(exp);
        case '<=':
            return Number(act) <= Number(exp);
        case '>':
            return Number(act) > Number(exp);
        case '>=':
            return Number(act) >= Number(exp);
        default:
            return false;
    }
}

export async function freeDiskMb(path: string): Promise<number | null> {
    try {
        const s = await statfs(path);
        return Math.round((s.bavail * s.bsize) / 1024 / 1024);
    } catch {
        return null;
    }
}

export async function preflight(input: PreflightInput): Promise<PreflightResult> {
    if (input.halted) {
        return { ok: false, kind: 'wait', reason: `Not-Aus aktiv${input.haltReason ? `: ${input.haltReason}` : ''}` };
    }
    if (input.dependencyErrors.length) {
        return { ok: false, kind: 'block', reason: `Abhängigkeiten: ${input.dependencyErrors.join('; ')}` };
    }
    if (input.nodeErrors?.errors.length) {
        return {
            ok: false,
            kind: 'block',
            reason: `Update auf Node.js ${input.nodeErrors.target} nicht möglich: ${input.nodeErrors.errors.join('; ')}`,
        };
    }
    const free = await freeDiskMb(input.diskPath);
    if (free !== null && free < input.minFreeMb) {
        return {
            ok: false,
            kind: 'block',
            reason: `Zu wenig Speicher: ${free} MB frei, ${input.minFreeMb} MB nötig für Download, Entpacken und Sicherung`,
        };
    }
    if (!input.window.ignore && !inWindow(input.now, input.window.start, input.window.end)) {
        return {
            ok: false,
            kind: 'wait',
            reason: `Außerhalb des Wartungsfensters (${input.window.start}–${input.window.end})`,
        };
    }
    for (const c of input.conditions) {
        if (!c.stateId) {
            continue;
        }
        const val = await input.readState(c.stateId);
        const label = c.label || c.stateId;
        if (val === undefined || val === null) {
            return { ok: false, kind: 'wait', reason: `${label}: Wert nicht verfügbar` };
        }
        if (!compare(val, c.op, c.value)) {
            return { ok: false, kind: 'wait', reason: `${label}: ${String(val)} (verlangt ${c.op} ${c.value})` };
        }
    }
    return { ok: true };
}
