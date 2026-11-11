import { INSTANCE_ID, SOFTWARE_ACTIONS, type DesiredMessage, type JobMessage, type JobStep } from './protocol';

/**
 * Command 'software' of the fleet management: remove an adapter, add or delete an instance right away, as
 * admin does it with the CLI. It runs with the detached runner of the command 'adapter' and under its files,
 * so only one of both runs at a time.
 */

const ADAPTER_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Whether this can be the name of an adapter
 *
 * @param name from the request
 */
export function validAdapterName(name: unknown): name is string {
    return typeof name === 'string' && ADAPTER_NAME.test(name);
}

export type SoftwareRequest = NonNullable<JobMessage['software']>;

/** An instance of the adapter, from its object */
export interface SoftwareInstance {
    id: string;
    host: string;
}

/** What the agent knows on this system about the adapter of the request */
export interface SoftwareContext {
    /** the agent itself, e.g. "bee.0" */
    own: string;
    host: string;
    desired: DesiredMessage | null;
    /** system.adapter.<adapter>, missing if not installed */
    adapterObj: ioBroker.Object | null | undefined;
    /** all instances of the adapter, on every host */
    instances: SoftwareInstance[];
}

/**
 * Why the command is refused; null if it may run
 *
 * @param req the request of the server
 * @param ctx see SoftwareContext
 */
export function softwareRefusal(req: unknown, ctx: SoftwareContext): string | null {
    const r = req as Partial<SoftwareRequest> | undefined;
    if (!r || !SOFTWARE_ACTIONS.includes(r.action as SoftwareRequest['action'])) {
        return `Unbekannte Aktion ${String(r?.action)}`;
    }
    if (!validAdapterName(r.adapter)) {
        return 'Ungültiger Adaptername';
    }
    if (r.adapter === 'js-controller') {
        return 'js-controller ist kein Adapter mit Instanzen';
    }
    const agent = ctx.own.split('.')[0];
    if (r.action === 'removeInstance') {
        const id = r.instance;
        if (typeof id !== 'string' || !INSTANCE_ID.test(id) || !id.startsWith(`${r.adapter}.`)) {
            return `Ungültige Instanz ${String(id)}`;
        }
        if (id === ctx.own) {
            return `${id} löschen trennt die Anlage von der Flottenverwaltung; das geht nur am Gerät`;
        }
        const inst = ctx.instances.find(i => i.id === id);
        if (!inst) {
            return `Instanz ${id} gibt es auf dem Gerät nicht`;
        }
        if (inst.host !== ctx.host) {
            return `Instanz ${id} gehört zum Host ${inst.host}, nicht zu ${ctx.host}`;
        }
        return null;
    }
    if (!ctx.adapterObj || ctx.adapterObj.type !== 'adapter') {
        return `${r.adapter} ist nicht installiert`;
    }
    if (r.action === 'removeAdapter') {
        if (r.adapter === agent) {
            return `${agent} entfernen trennt die Anlage von der Flottenverwaltung; das geht nur am Gerät`;
        }
        if (ctx.desired?.mode === 'managed' && ctx.desired.profile?.adapters?.[r.adapter]) {
            // the next job would install it again
            return `${r.adapter} gehört zum Sollprofil der Anlage: über die Version je Anlage entfernen`;
        }
        const foreign = ctx.instances.filter(i => i.host !== ctx.host).map(i => i.id);
        if (foreign.length) {
            return `${r.adapter} hat Instanzen auf anderen Hosts (${foreign.join(', ')}); das geht nur am Gerät`;
        }
        return null;
    }
    // addInstance
    if (r.adapter === agent) {
        return `Eine zweite Instanz von ${agent} ist nicht vorgesehen`;
    }
    const common = ctx.adapterObj.common as ioBroker.AdapterCommon;
    if (common.singleton && ctx.instances.length) {
        return `${r.adapter} erlaubt nur eine Instanz`;
    }
    if (common.singletonHost && ctx.instances.some(i => i.host === ctx.host)) {
        return `${r.adapter} erlaubt nur eine Instanz je Host`;
    }
    return null;
}

/**
 * The number of the next instance, as js-controller chooses it (the highest one plus one)
 *
 * @param adapter name of the adapter
 * @param instances all instances of the adapter
 */
export function nextInstance(adapter: string, instances: SoftwareInstance[]): string {
    let max = -1;
    for (const i of instances) {
        const n = parseInt(i.id.slice(adapter.length + 1), 10);
        if (i.id.startsWith(`${adapter}.`) && n > max) {
            max = n;
        }
    }
    return `${adapter}.${max + 1}`;
}

/**
 * The step for the runner and the texts of the answers
 *
 * @param req a request without refusal
 * @param ctx see SoftwareContext
 */
export function softwarePlan(
    req: SoftwareRequest,
    ctx: SoftwareContext,
): { step: JobStep; running: string; what: string; done: string } {
    if (req.action === 'removeAdapter') {
        const version = (ctx.adapterObj?.common as ioBroker.AdapterCommon | undefined)?.version;
        return {
            step: { action: 'remove', adapter: req.adapter, from: version ?? null, to: null, status: 'pending' },
            running: `${req.adapter} wird mit allen Instanzen entfernt`,
            what: req.adapter,
            done: `${req.adapter} entfernt`,
        };
    }
    if (req.action === 'addInstance') {
        const id = nextInstance(req.adapter, ctx.instances);
        return {
            step: { action: 'addInstance', adapter: req.adapter, instance: id, status: 'pending' },
            running: `Instanz ${id} wird angelegt`,
            what: id,
            done: `Instanz ${id} angelegt`,
        };
    }
    return {
        step: { action: 'removeInstance', adapter: req.adapter, instance: req.instance, status: 'pending' },
        running: `Instanz ${req.instance} wird gelöscht`,
        what: req.instance!,
        done: `Instanz ${req.instance} gelöscht`,
    };
}
