import * as utils from '@iobroker/adapter-core';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { enroll } from './lib/enrollment';
import { collectInventory, cpuTemperature, diskInfo, installedVersions, sdWrites } from './lib/inventory';
import { JobManager, type JobFile } from './lib/jobs';
import { checkDependencies, computePlan, foreignAdapters } from './lib/planner';
import { preflight, type Condition } from './lib/preflight';
import {
    normalizeComment,
    PROTOCOL_VERSION,
    type AccessKind,
    type ControlMessage,
    type DesiredMessage,
    type EnrollResponse,
    type Inventory,
    type JobMessage,
    type JobState,
    type ResultMessage,
    type StateMessage,
    type TunnelRequest,
} from './lib/protocol';
import {
    ACCESS_LABEL,
    chooseTarget,
    describeTargets,
    findTargets,
    trustedTunnelUrl,
    TunnelClient,
    type AccessTarget,
} from './lib/remote';
import { Transport, trustedCas } from './lib/transport';
import { diffFlat, flatten, readJson, writeJsonAtomic } from './lib/util';

interface BeeConfig {
    enrollUrl: string;
    enrollToken: string;
    /** Free text shown in the fleet management, e.g. "Womo Mercedes KA-1525" */
    comment: string;
    /** Remote access from the fleet management to admin, and to web/vis-2 */
    allowAdmin: boolean;
    allowVis: boolean;
    windowStart: string;
    windowEnd: string;
    ignoreWindow: boolean;
    conditions: Condition[];
    minFreeMb: number;
    signalStateId: string;
    heartbeatMinutes: number;
    checkMinutes: number;
    keepaliveSeconds: number;
    verifySeconds: number;
    startTimeoutSeconds: number;
    backupBeforeUpdate: boolean;
}

interface Persisted {
    /** Results per `${profileHash}:${retry}` so that a blocked job is not repeated */
    results: Record<string, 'done' | 'blocked'>;
    lastResult: ResultMessage | null;
    lastBackup: Inventory['backup']['lastLocal'];
    notified: Record<string, number>;
}

class BeeAdapter extends utils.Adapter {
    declare config: BeeConfig;
    private dataDir = '';
    private creds: EnrollResponse | null = null;
    private transport: Transport | null = null;
    private jobs: JobManager | null = null;
    private desired: DesiredMessage | null = null;
    private control: ControlMessage | null = null;
    private persisted: Persisted = { results: {}, lastResult: null, lastBackup: null, notified: {} };
    private timers: NodeJS.Timeout[] = [];
    private enrollTimer: NodeJS.Timeout | null = null;
    private enrollBackoff = 30_000;
    private seq = 0;
    private lastFlat: Record<string, unknown> | null = null;
    private uuid = '';
    private errorLog: { ts: number; from: string; message: string }[] = [];
    private errorsSinceHeartbeat = 0;
    private reconciling = false;
    private lastWaitReason = '';
    private unloading = false;
    /** Open remote access sessions by session id */
    private readonly tunnels = new Map<string, TunnelClient>();

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'bee' });
        this.on('ready', () => this.onReady());
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
        this.on('unload', callback => void this.onUnload(callback));
        this.on('log', (msg: ioBroker.LogMessage) => this.onLog(msg));
    }

    // ------------------------------------------------------------------ lifecycle

    private async onReady(): Promise<void> {
        this.dataDir = utils.getAbsoluteInstanceDataDir(this);
        mkdirSync(this.dataDir, { recursive: true });
        await this.setState('info.connection', false, true);

        const meta = await this.getForeignObjectAsync('system.meta.uuid');
        this.uuid = (meta?.native as { uuid?: string } | undefined)?.uuid || '';

        this.persisted = { ...this.persisted, ...(await readJson<Persisted>(join(this.dataDir, 'state.json'))) };
        this.desired = await readJson<DesiredMessage>(join(this.dataDir, 'desired.json'));
        this.control = await readJson<ControlMessage>(join(this.dataDir, 'control.json'));

        this.jobs = new JobManager({
            dataDir: this.dataDir,
            iobrokerJs: join(utils.controllerDir, 'iobroker.js'),
            cwd: join(utils.controllerDir, '..', '..'),
            log: this.log,
            verifySeconds: this.config.verifySeconds || 120,
            startTimeoutSeconds: this.config.startTimeoutSeconds || 300,
            report: job => this.reportJob(job),
            installed: async () => installedVersions(await this.inventory()),
            instancesOf: adapter => this.instancesOf(adapter),
            errorsSince: (ts, adapters) =>
                this.errorLog.filter(e => e.ts >= ts && adapters.some(a => e.from.startsWith(`${a}.`))),
            onFinished: (job, result) => this.onJobFinished(job, result),
        });
        await this.jobs.load();
        await this.jobs.setHalt(!!this.control?.halt);
        // count error log lines of all instances (verification and heartbeat)
        await this.requireLog?.(true);

        await this.subscribeStatesAsync('control.*');
        await this.updateInfoStates();

        this.creds = await readJson<EnrollResponse>(join(this.dataDir, 'device.json'));
        await this.updateAccessStates();
        if (this.creds) {
            this.startTransport();
            // sessions that were open before a restart (e.g. after a change of the settings)
            for (const t of (await readJson<TunnelRequest[]>(join(this.dataDir, 'tunnels.json'))) || []) {
                await this.openTunnel(t, true);
            }
        } else {
            await this.tryEnroll();
        }

        this.timers.push(setInterval(() => void this.jobs?.poll(), 2000));
        this.timers.push(setInterval(() => void this.heartbeat(), (this.config.heartbeatMinutes || 60) * 60_000));
        this.timers.push(
            setInterval(
                () => {
                    void this.sendInventory(false);
                    void this.reconcile();
                },
                (this.config.checkMinutes || 5) * 60_000,
            ),
        );
    }

    private async onUnload(callback: () => void): Promise<void> {
        this.unloading = true;
        try {
            this.timers.forEach(t => clearInterval(t));
            if (this.enrollTimer) {
                clearTimeout(this.enrollTimer);
            }
            // the sessions stay in tunnels.json and are resumed after the restart
            for (const client of [...this.tunnels.values()]) {
                client.stop('agent stops');
            }
            // js-controller kills slow adapters; the Last Will covers a disconnect that does not finish in time
            await Promise.race([this.transport?.stop(), new Promise(resolve => setTimeout(resolve, 800))]);
            await this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }

    private async savePersisted(): Promise<void> {
        await writeJsonAtomic(join(this.dataDir, 'state.json'), this.persisted);
    }

    // ------------------------------------------------------------------ enrollment

    private async stopWithReason(reason: string): Promise<void> {
        this.log.error(`Beekeeper rejected this device: ${reason}. The agent stops.`);
        await this.setState('info.status', `Abgewiesen: ${reason}`, true);
        await this.notify('rejected', `Die Flottenverwaltung hat dieses Gerät abgewiesen: ${reason}`);
        // explicit rejection: stop instead of knocking again; js-controller does not restart us
        this.terminate(reason, utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
    }

    private async tryEnroll(): Promise<void> {
        if (!this.config.enrollUrl || !this.config.enrollToken) {
            await this.setState('info.status', 'Nicht konfiguriert: Enrollment-URL und Token fehlen', true);
            this.log.warn('Enrollment URL or token missing, please configure the adapter');
            return;
        }
        await this.setState('info.status', 'Anmeldung beim Server …', true);
        const result = await enroll(this.config.enrollUrl, {
            token: this.config.enrollToken,
            uuid: this.uuid,
            hostname: os.hostname(),
            agentVersion: this.version,
            comment: normalizeComment(this.config.comment),
        });
        if (result.kind === 'ok') {
            this.creds = result.creds;
            await writeJsonAtomic(join(this.dataDir, 'device.json'), result.creds);
            this.log.info(`Enrolled as ${result.creds.deviceId} (asset ${result.creds.assetId})`);
            await this.updateInfoStates();
            this.startTransport();
        } else if (result.kind === 'rejected') {
            await this.stopWithReason(result.reason);
        } else {
            // network or server trouble is no reason to stop: retry with growing distance
            const delay = this.enrollBackoff;
            this.enrollBackoff = Math.min(this.enrollBackoff * 2, 24 * 3600_000);
            this.log.warn(`Enrollment failed (${result.reason}), retry in ${Math.round(delay / 1000)} s`);
            await this.setState(
                'info.status',
                `Anmeldung fehlgeschlagen, neuer Versuch in ${Math.round(delay / 60000)} min`,
                true,
            );
            this.enrollTimer = setTimeout(() => {
                this.enrollTimer = null;
                void this.tryEnroll();
            }, delay);
        }
    }

    // ------------------------------------------------------------------ transport

    private startTransport(): void {
        const transport = new Transport(this.creds!, { keepalive: this.config.keepaliveSeconds || 300, log: this.log });
        this.transport = transport;
        transport.on('connected', () => void this.onConnected());
        transport.on('disconnected', () => {
            void this.setState('info.connection', false, true);
        });
        transport.on('desired', msg => void this.onDesired(msg));
        transport.on('control', msg => void this.onControl(msg));
        transport.on('job', msg => void this.onJob(msg));
        transport.on('rejected', reason => void this.stopWithReason(reason));
        transport.start();
    }

    private async onConnected(): Promise<void> {
        this.log.info('Connected to beekeeper');
        await this.setState('info.connection', true, true);
        await this.setState('info.status', 'Verbunden', true);
        await this.heartbeat();
        await this.sendInventory(true);
        // results produced while offline
        if (this.jobs?.job) {
            await this.reportJob(this.jobs.job);
        } else if (this.persisted.lastResult) {
            await this.transport?.publish('result', this.persisted.lastResult);
        }
    }

    private async onDesired(msg: DesiredMessage | null): Promise<void> {
        this.desired = msg;
        await writeJsonAtomic(join(this.dataDir, 'desired.json'), msg);
        this.log.info(
            msg?.profile
                ? `Desired state: ${msg.profile.name} (${msg.mode}${msg.retry ? `, retry ${msg.retry}` : ''})`
                : 'No desired state',
        );
        await this.updateInfoStates();
        this.lastWaitReason = '';
        await this.reconcile();
    }

    private async onControl(msg: ControlMessage): Promise<void> {
        // log only real changes, not the retained state delivered on every connect
        const changed = msg.halt !== !!this.control?.halt;
        this.control = msg;
        await writeJsonAtomic(join(this.dataDir, 'control.json'), msg);
        await this.jobs?.setHalt(msg.halt);
        await this.setState('control.halted', msg.halt, true);
        if (changed) {
            this.log.warn(msg.halt ? `Emergency stop: ${msg.reason || 'no reason given'}` : 'Emergency stop released');
            if (!msg.halt) {
                await this.reconcile();
            }
        }
    }

    private async onJob(msg: JobMessage): Promise<void> {
        if (msg.cmd === 'resync' || msg.cmd === 'refresh') {
            await this.sendInventory(true);
        } else if (msg.cmd === 'tunnel' && msg.tunnel) {
            await this.openTunnel(msg.tunnel, false);
        }
    }

    // ------------------------------------------------------------------ remote access

    /** Kinds of remote access the owner allows in the instance settings */
    private allowedAccess(): AccessKind[] {
        const kinds: AccessKind[] = [];
        if (this.config.allowAdmin !== false) {
            kinds.push('admin');
        }
        if (this.config.allowVis !== false) {
            kinds.push('vis');
        }
        return kinds;
    }

    /**
     * Opens the tunnel of an access session, or refuses it with a reason the operator sees.
     *
     * @param t request of the server
     * @param resumed the session was open before a restart of the agent
     */
    private async openTunnel(t: TunnelRequest, resumed: boolean): Promise<void> {
        if (this.tunnels.has(t.id) || t.expiresAt <= Date.now() || this.unloading) {
            // repeated delivery of the job, or over
            return;
        }
        if (!trustedTunnelUrl(t.url, [this.config.enrollUrl, this.creds?.mqttUrl || ''])) {
            this.log.warn(`Remote access: tunnel URL ${t.url} does not belong to the fleet server, ignored`);
            return;
        }
        let refusal: string | null = null;
        let target: AccessTarget | null = null;
        if (!this.allowedAccess().includes(t.kind)) {
            refusal = `Fernzugriff auf ${ACCESS_LABEL[t.kind]} ist am Gerät abgeschaltet`;
        } else {
            // only an instance of this kind on this host, whatever the server asks for
            target = chooseTarget(await findTargets(this, t.kind), t.instance);
            if (!target) {
                refusal = t.instance
                    ? `Instanz ${t.instance} ist auf dem Gerät nicht aktiv`
                    : `Keine aktive ${t.kind === 'admin' ? 'admin' : 'web'}-Instanz auf dem Gerät`;
            } else if (this.tunnels.size >= 4) {
                refusal = 'Zu viele gleichzeitige Fernzugriffe auf dem Gerät';
            }
        }
        const client = new TunnelClient(t, {
            target,
            refusal,
            ca: trustedCas(this.creds?.ca || ''),
            log: this.log,
            onEnd: (c, reason) => {
                if (this.tunnels.get(t.id) === c) {
                    this.tunnels.delete(t.id);
                    this.log.info(`Remote access to ${ACCESS_LABEL[t.kind]} by ${t.by} ended (${reason})`);
                }
                if (!this.unloading) {
                    void this.saveTunnels();
                    void this.updateAccessStates();
                }
            },
        });
        if (refusal) {
            this.log.warn(`Remote access to ${ACCESS_LABEL[t.kind]} by ${t.by} refused: ${refusal}`);
        } else {
            this.tunnels.set(t.id, client);
            this.log.info(
                `Remote access to ${ACCESS_LABEL[t.kind]} (${target!.instance}) ${resumed ? 'resumed' : 'opened'} by ${t.by} until ${new Date(t.expiresAt).toLocaleTimeString()}: ${t.purpose}`,
            );
        }
        client.start();
        await this.saveTunnels();
        await this.updateAccessStates();
    }

    private async saveTunnels(): Promise<void> {
        await writeJsonAtomic(
            join(this.dataDir, 'tunnels.json'),
            [...this.tunnels.values()].map(c => c.req),
        );
    }

    /** Shows the owner who is connected right now, and why */
    private async updateAccessStates(): Promise<void> {
        const active = [...this.tunnels.values()].map(c => c.req);
        await this.setState('info.remoteAccess', active.length > 0, true);
        await this.setState(
            'info.remoteAccessBy',
            active
                .map(
                    t =>
                        `${ACCESS_LABEL[t.kind]}${t.instance ? ` (${t.instance})` : ''}: ${t.by}, ${t.purpose} (bis ${new Date(t.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
                )
                .join('; '),
            true,
        );
    }

    // ------------------------------------------------------------------ inventory and heartbeat

    private async inventory(): Promise<Inventory> {
        const inv = await collectInventory(this, {
            agentVersion: this.version || '',
            dataDir: this.dataDir,
            lastBackup: this.persisted.lastBackup,
        });
        inv.uuid = this.uuid;
        const comment = normalizeComment(this.config.comment);
        if (comment) {
            inv.comment = comment;
        }
        // also tells the server that this agent can open a tunnel at all
        inv.remoteAccess = this.allowedAccess();
        inv.accessTargets = {
            admin: describeTargets(await findTargets(this, 'admin')),
            vis: describeTargets(await findTargets(this, 'vis')),
        };
        return inv;
    }

    private async sendInventory(full: boolean): Promise<void> {
        if (!this.transport?.connected) {
            return;
        }
        const inv = await this.inventory();
        const flat = flatten(inv);
        if (full || !this.lastFlat) {
            this.seq++;
            await this.transport.publish('inventory', {
                v: PROTOCOL_VERSION,
                ts: Date.now(),
                seq: this.seq,
                type: 'full',
                data: inv,
            });
        } else {
            const { set, unset } = diffFlat(this.lastFlat, flat);
            if (!Object.keys(set).length && !unset.length) {
                return;
            }
            this.seq++;
            await this.transport.publish('inventory', {
                v: PROTOCOL_VERSION,
                ts: Date.now(),
                seq: this.seq,
                type: 'diff',
                baseSeq: this.seq - 1,
                set,
                unset,
            });
        }
        this.lastFlat = flat;
    }

    private async heartbeat(): Promise<void> {
        const disk = await diskInfo(this.dataDir);
        let signal: number | null = null;
        if (this.config.signalStateId) {
            const s = await this.getForeignStateAsync(this.config.signalStateId);
            signal = typeof s?.val === 'number' ? s.val : null;
        }
        const msg: StateMessage = {
            v: PROTOCOL_VERSION,
            ts: Date.now(),
            online: true,
            agentVersion: this.version,
            uptime: Math.round(os.uptime()),
            load: Math.round(os.loadavg()[0] * 100) / 100,
            memFree: os.freemem(),
            diskFree: disk?.free,
            temperature: (await cpuTemperature()) ?? undefined,
            logErrors: this.errorsSinceHeartbeat,
            jobState: this.jobs?.job?.state,
            signal,
            sdWrites: await sdWrites(),
        };
        this.errorsSinceHeartbeat = 0;
        await this.transport?.publish('state', msg);
    }

    private onLog(msg: ioBroker.LogMessage): void {
        if (msg.severity !== 'error' || msg.from?.startsWith(`${this.namespace}`)) {
            return;
        }
        this.errorsSinceHeartbeat++;
        this.errorLog.push({ ts: Date.now(), from: msg.from, message: String(msg.message) });
        if (this.errorLog.length > 500) {
            this.errorLog.splice(0, this.errorLog.length - 500);
        }
    }

    private async instancesOf(adapter: string): Promise<{ id: string; alive: boolean }[]> {
        const res = await this.getObjectViewAsync('system', 'instance', {
            startkey: `system.adapter.${adapter}.`,
            endkey: `system.adapter.${adapter}.香`,
        });
        const list: { id: string; alive: boolean }[] = [];
        for (const row of res.rows) {
            const obj = row.value;
            if (!obj?.common.enabled || obj.common.host !== this.host) {
                continue;
            }
            // scheduled instances are not running permanently
            if (obj.common.mode !== 'daemon') {
                continue;
            }
            const alive = await this.getForeignStateAsync(`${obj._id}.alive`);
            list.push({ id: obj._id.replace('system.adapter.', ''), alive: !!alive?.val });
        }
        return list;
    }

    // ------------------------------------------------------------------ reconciliation

    private async report(state: JobState, detail: string, steps?: JobFile['steps']): Promise<void> {
        const d = this.desired;
        if (!d?.profile) {
            return;
        }
        const msg: ResultMessage = {
            v: PROTOCOL_VERSION,
            ts: Date.now(),
            profileId: d.profile.id,
            profileHash: d.profile.hash,
            retry: d.retry,
            state,
            detail,
            steps,
        };
        this.persisted.lastResult = msg;
        await this.savePersisted();
        await this.setState('job.state', state, true);
        await this.setState('job.detail', detail, true);
        await this.transport?.publish('result', msg);
    }

    private async reportJob(job: JobFile): Promise<void> {
        const msg: ResultMessage = {
            v: PROTOCOL_VERSION,
            ts: Date.now(),
            profileId: job.profileId,
            profileHash: job.profileHash,
            retry: job.retry,
            state: job.state,
            detail: job.detail,
            steps: job.steps,
        };
        this.persisted.lastResult = msg;
        await this.savePersisted();
        await this.setState('job.state', job.state, true);
        await this.setState('job.detail', job.detail, true);
        await this.setState('job.steps', JSON.stringify(job.steps), true);
        await this.transport?.publish('result', msg);
    }

    private async onJobFinished(job: JobFile, result: 'done' | 'blocked' | 'waiting'): Promise<void> {
        if (result !== 'waiting') {
            this.persisted.results[job.key] = result;
        }
        const backup = job.steps.find(s => s.action === 'backup' && s.status === 'ok');
        if (backup?.detail) {
            this.persisted.lastBackup = { ts: backup.ts || Date.now(), file: backup.detail, size: 0 };
        }
        await this.savePersisted();
        this.log.info(`Job ${job.profileName}: ${result} (${job.detail})`);
        if (result === 'done') {
            await this.notify('updated', `Das System wurde auf den Stand ${job.profileName} gebracht.`);
        }
        await this.sendInventory(false);
        await this.updateInfoStates();
        // the desired state may have changed while the job was running
        setTimeout(() => void this.reconcile(), 1000);
    }

    /** Converges on the desired state if possible. Never runs two jobs at once. */
    private async reconcile(): Promise<void> {
        if (this.reconciling || this.unloading || !this.jobs || this.jobs.isActive()) {
            return;
        }
        this.reconciling = true;
        try {
            await this.reconcileInner();
        } catch (e) {
            this.log.error(`Reconcile: ${e.stack || e.message}`);
        } finally {
            this.reconciling = false;
        }
    }

    private async reconcileInner(): Promise<void> {
        const d = this.desired;
        if (!d?.profile) {
            return;
        }
        const inv = await this.inventory();
        const installed = installedVersions(inv);
        const plan = computePlan(d, installed, this.name);
        await this.setState('info.onTarget', plan.length === 0, true);

        if (d.mode === 'self') {
            // self-managed: no automatic rollout, only a hint about the new state
            if (plan.length && !this.persisted.notified[`update:${d.profile.hash}`]) {
                this.persisted.notified[`update:${d.profile.hash}`] = Date.now();
                await this.savePersisted();
                await this.notify(
                    'updateAvailable',
                    `Neuer Softwarestand ${d.profile.name} verfügbar (${plan.length} Änderungen). Die Anlage ist eigenverantwortlich und wird nicht automatisch aktualisiert.`,
                );
            }
            return;
        }
        const foreign = foreignAdapters(d, installed);
        if (foreign.length) {
            // own installations: do not touch anything; the server switches the mode and informs the dealer
            const key = `foreign:${foreign.join(',')}`;
            if (!this.persisted.notified[key]) {
                this.persisted.notified[key] = Date.now();
                await this.savePersisted();
                await this.notify(
                    'modeChanged',
                    `Selbst installierte Adapter erkannt (${foreign.join(', ')}). Die Anlage erhält keine automatischen Updates mehr, bis sie in den verwalteten Modus zurückgeführt wird.`,
                );
            }
            await this.setState('info.status', `Eigeninstallation erkannt: ${foreign.join(', ')}`, true);
            return;
        }
        const key = `${d.profile.hash}:${d.retry}`;
        if (this.persisted.results[key] === 'blocked') {
            return;
        }
        if (!plan.length) {
            if (this.persisted.results[key] !== 'done') {
                this.persisted.results[key] = 'done';
                await this.report('done', 'Bereits auf Sollstand');
            }
            return;
        }
        // drift after an earlier success (e.g. manual change): converge again
        delete this.persisted.results[key];

        const pf = await preflight({
            now: new Date(),
            halted: !!this.control?.halt,
            haltReason: this.control?.reason,
            window: {
                start: this.config.windowStart || '02:00',
                end: this.config.windowEnd || '05:00',
                ignore: !!this.config.ignoreWindow,
            },
            conditions: (this.config.conditions || []).filter(c => c?.stateId),
            readState: async id => (await this.getForeignStateAsync(id))?.val ?? undefined,
            diskPath: this.dataDir,
            minFreeMb: this.config.minFreeMb || 1024,
            dependencyErrors: checkDependencies(d, installed, {
                jsController: inv.software.jsController,
                node: process.version,
            }),
        });
        if (!pf.ok) {
            if (pf.kind === 'block') {
                this.persisted.results[key] = 'blocked';
                await this.report('blocked', pf.reason, plan);
            } else if (pf.reason !== this.lastWaitReason) {
                this.lastWaitReason = pf.reason;
                await this.report('waiting', pf.reason, plan);
            }
            return;
        }
        this.lastWaitReason = '';
        this.log.info(`Starting job for ${d.profile.name}: ${plan.map(s => `${s.action} ${s.adapter}`).join(', ')}`);
        await this.report('preflight', `${plan.length} Schritte geplant, Vorprüfung bestanden`, plan);
        await this.jobs!.start(d, plan, this.config.backupBeforeUpdate !== false);
    }

    // ------------------------------------------------------------------ states, notifications

    private async updateInfoStates(): Promise<void> {
        await this.setState('info.deviceId', this.creds?.deviceId || '', true);
        await this.setState('info.assetId', this.creds?.assetId || '', true);
        await this.setState('info.mode', this.desired?.mode || '', true);
        await this.setState('info.profile', this.desired?.profile?.name || '', true);
    }

    private async notify(
        category: 'modeChanged' | 'updateAvailable' | 'updated' | 'rejected',
        message: string,
    ): Promise<void> {
        try {
            await this.registerNotification('bee', category, message);
        } catch (e) {
            this.log.debug(`Notification not possible: ${e.message}`);
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        }
        if (id === `${this.namespace}.control.refresh`) {
            await this.sendInventory(true);
            await this.setState('control.refresh', false, true);
        } else if (id === `${this.namespace}.control.check`) {
            this.lastWaitReason = '';
            await this.reconcile();
            await this.setState('control.check', false, true);
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new BeeAdapter(options);
} else {
    (() => new BeeAdapter())();
}
