import { compare } from './preflight';
import { MONITOR_OPS, MONITOR_SEVERITIES, type MonitorOp, type MonitorSeverity, type MonitorStatus } from './protocol';

/**
 * Monitoring: the owner or the integrator sets rules on states in the instance, e.g. "victron.0.voltage < 11.5,
 * warning". The agent watches the states and reports in the inventory how each rule stands; a rule that alerts is a
 * deviation of the asset in the fleet management, with its notifications by mail or Telegram.
 *
 * A rule alerts once its condition holds for its delay, and stops once the condition is gone for as long: a battery
 * that dips under load for a moment, or wavers at the limit, raises nothing.
 */

/** A rule as set in the instance (table "Überwachung") */
export interface MonitorRule {
    label?: string;
    stateId: string;
    op: MonitorOp;
    /** The limit: "11.5" (also "11,5" or "11,5 V"), true, a text; with stale the minutes */
    value: string;
    severity: MonitorSeverity;
    /** Seconds the condition must hold before the rule alerts, and be gone before it stops */
    delay?: number;
}

export const DEFAULT_DELAY_S = 60;
/** More would make the inventory large; nobody watches that many states by hand */
export const MAX_RULES = 100;

/** The rules of the configuration that can work, at most MAX_RULES */
export function validRules(raw: unknown): MonitorRule[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const rules: MonitorRule[] = [];
    for (const r of raw) {
        const stateId = typeof r?.stateId === 'string' ? r.stateId.trim() : '';
        const op = MONITOR_OPS.includes(r?.op) ? (r.op as MonitorOp) : null;
        const value = r?.value === undefined || r?.value === null ? '' : String(r.value).trim();
        if (!stateId || !op || (op === 'stale' && !(Number(limitOf(value)) > 0)) || (op !== 'stale' && value === '')) {
            continue;
        }
        const delay = Number(r.delay);
        rules.push({
            stateId,
            op,
            value,
            severity: MONITOR_SEVERITIES.includes(r.severity) ? r.severity : 'warning',
            delay: Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 24 * 3600) : DEFAULT_DELAY_S,
            ...(typeof r.label === 'string' && r.label.trim() ? { label: r.label.trim().slice(0, 100) } : {}),
        });
    }
    return rules.slice(0, MAX_RULES);
}

/** The same as long as state, condition and limit stay */
export function ruleId(r: Pick<MonitorRule, 'stateId' | 'op' | 'value'>): string {
    return `${r.stateId} ${r.op} ${r.value}`;
}

/** "11,5", "11.5 V" and "-3" are numbers; everything else stays as it is for compare() */
export function limitOf(value: string): string {
    const m = /^(-?\d+(?:[.,]\d+)?)\s*[^\d\s.,]*$/.exec(value.trim());
    return m ? m[1].replace(',', '.') : value.trim();
}

/**
 * Whether the condition of a rule holds
 *
 * @param rule the rule
 * @param state the state, undefined or null if it does not exist
 * @param now the time
 * @returns null if the state has no value (a comparison cannot be made)
 */
export function holds(
    rule: MonitorRule,
    state: { val: ioBroker.StateValue; ts: number } | null | undefined,
    now: number,
): boolean | null {
    if (rule.op === 'stale') {
        // never written is as stale as it gets
        return !state?.ts || now - state.ts > Number(limitOf(rule.value)) * 60_000;
    }
    if (!state || state.val === null || state.val === undefined) {
        return null;
    }
    return compare(state.val, rule.op, limitOf(rule.value));
}

interface Track {
    rule: MonitorRule;
    /** The condition as last seen, and since when */
    cond: boolean;
    condSince: number;
    alert: boolean;
    alertVal?: ioBroker.StateValue;
    missing: boolean;
}

export class Monitor {
    private readonly tracks: Track[];
    private readonly states = new Map<string, { val: ioBroker.StateValue; ts: number } | null>();
    private readonly units = new Map<string, string>();

    constructor(rules: MonitorRule[], now = Date.now()) {
        this.tracks = rules.map(rule => ({ rule, cond: false, condSince: now, alert: false, missing: false }));
    }

    /** The states to subscribe to */
    stateIds(): string[] {
        return [...new Set(this.tracks.map(t => t.rule.stateId))];
    }

    watches(id: string): boolean {
        return this.tracks.some(t => t.rule.stateId === id);
    }

    setUnit(id: string, unit: unknown): void {
        if (typeof unit === 'string' && unit.trim()) {
            this.units.set(id, unit.trim());
        }
    }

    /** A new value of a watched state; null: the state was deleted */
    update(id: string, state: ioBroker.State | null | undefined): void {
        this.states.set(id, state ? { val: state.val, ts: state.ts } : null);
    }

    /**
     * Applies the delays
     *
     * @returns the rules whose alert started or stopped, or that lost or found their state
     */
    evaluate(now = Date.now()): MonitorStatus[] {
        const changed: MonitorStatus[] = [];
        for (const t of this.tracks) {
            const state = this.states.get(t.rule.stateId);
            const result = holds(t.rule, state, now);
            const missing = result === null || (t.rule.op === 'stale' ? false : !state);
            const cond = result === true;
            if (cond !== t.cond) {
                t.cond = cond;
                t.condSince = now;
            }
            const held = now - t.condSince >= (t.rule.delay ?? DEFAULT_DELAY_S) * 1000;
            let flipped = false;
            if (!t.alert && cond && held) {
                t.alert = true;
                t.alertVal = state?.val;
                flipped = true;
            } else if (t.alert && !cond && held) {
                t.alert = false;
                t.alertVal = undefined;
                flipped = true;
            }
            if (missing !== t.missing) {
                t.missing = missing;
                flipped = true;
            }
            if (flipped) {
                changed.push(this.statusOf(t));
            }
        }
        return changed;
    }

    status(): MonitorStatus[] {
        return this.tracks.map(t => this.statusOf(t));
    }

    private statusOf(t: Track): MonitorStatus {
        const state = this.states.get(t.rule.stateId);
        const unit = this.units.get(t.rule.stateId);
        const val = t.alert ? t.alertVal : state?.val;
        return {
            id: ruleId(t.rule),
            ...(t.rule.label ? { label: t.rule.label } : {}),
            stateId: t.rule.stateId,
            op: t.rule.op,
            value: t.rule.value,
            severity: t.rule.severity,
            ...(unit ? { unit } : {}),
            alert: t.alert,
            ...(t.alert ? { since: t.condSince } : {}),
            ...(val !== undefined ? { val: typeof val === 'object' && val !== null ? JSON.stringify(val) : val } : {}),
            ...(state?.ts ? { ts: state.ts } : {}),
            ...(t.missing ? { missing: true } : {}),
        };
    }
}

/** A line for the log of ioBroker: "Bordbatterie (victron.0.voltage): 11.2 V, meldet bei < 11.5" */
export function monitorText(m: MonitorStatus): string {
    const name = m.label ? `${m.label} (${m.stateId})` : m.stateId;
    const unit = m.unit ? ` ${m.unit}` : '';
    if (m.missing) {
        return `${name}: no value`;
    }
    if (m.op === 'stale') {
        return `${name}: ${m.alert ? 'no update' : 'updated again'} (limit ${m.value} min)`;
    }
    return `${name}: ${String(m.val)}${unit} (${m.alert ? 'alert' : 'ok'}, limit ${m.op} ${m.value})`;
}
