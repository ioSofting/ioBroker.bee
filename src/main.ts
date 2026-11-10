import * as utils from '@iobroker/adapter-core';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import {
    ACTION_DONE,
    chooseOsPackages,
    instanceRefusal,
    osUpdatesFrom,
    REBOOT_REQUIRED,
    supportedCommands,
} from './lib/commands';
import { consoleUser, findScript, MAX_SHELLS, startShell } from './lib/console';
import { instanceRunning, onlyWww } from './lib/instances';
import { enroll } from './lib/enrollment';
import { collectInventory, cpuTemperature, diskInfo, installedVersions, sdWrites } from './lib/inventory';
import { JobManager, type JobFile } from './lib/jobs';
import { findLogFile, listLogFiles, logDirs, uploadLog } from './lib/logs';
import {
    engineConflicts,
    launchNodeUpdate,
    nodeBlockers,
    nodeFacts,
    readEngines,
    serviceOf,
    unitActive,
} from './lib/node';
import { ensurePackage, packagesOf, trustedPackageUrl } from './lib/packages';
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
    type JobStep,
    type ReplyMessage,
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
import { CONSOLE, consoleMessage } from './lib/tunnel';
import { diffFlat, flatten, readJson, writeJsonAtomic } from './lib/util';

interface BeeConfig {
    enrollUrl: string;
    enrollToken: string;
    /** Free text shown in the fleet management, e.g. "Womo Mercedes KA-1525" */
    comment: string;
    /** Remote access from the fleet management to admin, and to web/vis-2 */
    allowAdmin: boolean;
    allowVis: boolean;
    /** A shell on this system for the fleet management (off unless the owner switches it on) */
    allowConsole: boolean;
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

/** Host of the broker for the status, e.g. "bee.iobroker.click" */
function hostOf(url: string | undefined): string {
    try {
        return new URL(url || '').hostname || 'der Flottenverwaltung';
    } catch {
        return 'der Flottenverwaltung';
    }
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
    /** A command of the fleet management is being carried out (one at a time) */
    private commandRunning = false;
    private logUploading = false;
    private lastWaitReason = '';
    private unloading = false;
    /** Open remote access sessions by session id */
    private readonly tunnels = new Map<string, TunnelClient>();
    /** Running shells of the console per session */
    private readonly shells = new Map<string, number>();

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
            running: async () => (await this.instancesOf()).filter(i => i.alive).map(i => i.id),
            launchNode: async (target, unit, waitSeconds) => {
                const service = serviceOf(await readFile('/proc/self/cgroup', 'utf8').catch(() => ''));
                if (!service) {
                    throw new Error('ioBroker läuft nicht als systemd-Dienst');
                }
                this.log.warn(`Node.js is updated to ${target}: ioBroker (${service}) restarts (fleet management)`);
                await launchNodeUpdate({ dir: this.dataDir, target, service, unit, waitSeconds });
            },
            unitActive: unit => unitActive(unit),
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
        await this.setState('info.status', `Verbunden mit ${hostOf(this.creds?.mqttUrl)}`, true);
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
        } else if (msg.ref && (msg.cmd === 'instance' || msg.cmd === 'restart' || msg.cmd === 'osUpgrade')) {
            await this.runCommand(msg);
        } else if (msg.ref && msg.cmd === 'logList') {
            // only reads: also during a job or another command
            await this.logListCommand(msg.ref);
        } else if (msg.ref && msg.cmd === 'logFetch') {
            // may take minutes on a mobile connection: the other messages go on meanwhile
            void this.logFetchCommand(msg.ref, msg.by || 'Flottenverwaltung', msg.logFetch);
        }
    }

    // ------------------------------------------------------------------ commands of the fleet management

    private async reply(
        ref: string,
        state: ReplyMessage['state'],
        message?: string,
        files?: ReplyMessage['files'],
    ): Promise<void> {
        const msg: ReplyMessage = {
            v: PROTOCOL_VERSION,
            ts: Date.now(),
            ref,
            state,
            ...(message ? { message } : {}),
            ...(files ? { files } : {}),
        };
        await this.transport?.publish('reply', msg);
    }

    /** Directories of the log files of ioBroker (file transports of iobroker.json) */
    private logDirs(): string[] {
        let config: unknown = null;
        try {
            config = utils.getConfig();
        } catch (e) {
            this.log.debug(`iobroker.json not readable: ${e.message}`);
        }
        return logDirs(config, join(utils.controllerDir, '..', '..'));
    }

    private async logListCommand(ref: string): Promise<void> {
        try {
            const files = await listLogFiles(this.logDirs());
            await this.reply(ref, 'done', `${files.length} Log-Dateien`, files);
        } catch (e) {
            await this.reply(ref, 'error', e.message);
        }
    }

    /** Uploads a log file to the own server, one at a time */
    private async logFetchCommand(ref: string, by: string, req: JobMessage['logFetch']): Promise<void> {
        try {
            if (this.logUploading) {
                throw new Error('Es wird schon eine Log-Datei übertragen');
            }
            if (!req || typeof req.url !== 'string' || typeof req.ticket !== 'string') {
                throw new Error('Unvollständige Anfrage');
            }
            if (!trustedPackageUrl(req.url, [this.config.enrollUrl, this.creds?.mqttUrl || ''])) {
                throw new Error(`${req.url} gehört nicht zum Flottenserver`);
            }
            const file = await findLogFile(this.logDirs(), req.file);
            if (!file) {
                throw new Error(`Log-Datei ${String(req.file)} gibt es nicht`);
            }
            this.logUploading = true;
            this.log.info(`Log file ${req.file} is uploaded on request of ${by} (fleet management)`);
            await this.reply(ref, 'running', `${req.file} wird komprimiert übertragen`);
            const bytes = await uploadLog(file, req.url, req.ticket, trustedCas(this.creds?.ca || ''));
            await this.reply(ref, 'done', `${req.file}: ${(bytes / 1024 / 1024).toFixed(1)} MB übertragen`);
        } catch (e) {
            this.log.warn(`Log file ${String(req?.file)} for ${by}: ${e.message}`);
            await this.reply(ref, 'error', e.message);
        } finally {
            this.logUploading = false;
        }
    }

    /** Sends the inventory again a while after a command, when the instances show its effect */
    private inventorySoon(): void {
        for (const ms of [5_000, 30_000]) {
            this.timers.push(setTimeout(() => void this.sendInventory(false), ms));
        }
    }

    private async runCommand(msg: JobMessage): Promise<void> {
        const ref = msg.ref!;
        const by = msg.by || 'Flottenverwaltung';
        if (this.reconciling || this.jobs?.isActive()) {
            await this.reply(ref, 'error', 'Während eines Auftrags (Update) nicht möglich');
            return;
        }
        if (this.commandRunning) {
            await this.reply(ref, 'error', 'Es läuft schon ein Befehl');
            return;
        }
        this.commandRunning = true;
        try {
            if (msg.cmd === 'instance') {
                await this.instanceCommand(ref, by, msg.instance);
            } else if (msg.cmd === 'restart') {
                this.log.warn(`Restart of ioBroker on request of ${by} (fleet management)`);
                // the answer goes out first, the restart takes the agent down too
                await this.reply(ref, 'done', 'ioBroker startet neu');
                this.sendToHost(`system.host.${this.host}`, 'restartController', {});
            } else if (msg.cmd === 'osUpgrade') {
                await this.osUpgradeCommand(ref, by, msg.osUpgrade);
            }
        } catch (e) {
            this.log.warn(`Command ${msg.cmd} of ${by} failed: ${e.message}`);
            await this.reply(ref, 'error', e.message);
        } finally {
            this.commandRunning = false;
        }
    }

    /** Start, stop or restart an instance on this host, the same way admin does it */
    private async instanceCommand(ref: string, by: string, req: JobMessage['instance']): Promise<void> {
        const id = req?.id;
        const action = req?.action;
        const objId = `system.adapter.${id}`;
        const obj = typeof id === 'string' && /^[\w.-]+$/.test(id) ? await this.getForeignObjectAsync(objId) : null;
        const refusal = instanceRefusal(id, action, this.namespace, obj, this.host || '');
        if (refusal || !req) {
            await this.reply(ref, 'error', refusal || 'Instanz fehlt');
            return;
        }
        this.log.info(`Instance ${req.id}: ${req.action} on request of ${by} (fleet management)`);
        const own = req.id === this.namespace;
        if (own) {
            // a restart of this instance ends this process: answer first
            await this.reply(ref, 'done', `${req.id} startet neu`);
        }
        await this.extendForeignObjectAsync(
            objId,
            req.action === 'restart' ? {} : { common: { enabled: req.action === 'start' } },
        );
        if (!own) {
            await this.reply(ref, 'done', `${req.id} ${ACTION_DONE[req.action]}`);
            this.inventorySoon();
        }
    }

    /** Upgrade OS packages through js-controller, only those it listed itself */
    private async osUpgradeCommand(ref: string, by: string, req: JobMessage['osUpgrade']): Promise<void> {
        const host = `system.host.${this.host}`;
        const hostObj = await this.getForeignObjectAsync(host);
        if (!supportedCommands(String(hostObj?.common?.installedVersion || '')).includes('osUpgrade')) {
            await this.reply(ref, 'error', 'OS-Updates brauchen Linux und js-controller ab 6');
            return;
        }
        const listed =
            osUpdatesFrom(await this.getForeignStateAsync(`${host}.osPackageUpdates`), false)?.packages ?? [];
        const { packages, unknown } = chooseOsPackages(listed, req?.packages);
        if (!packages.length || unknown.length) {
            await this.reply(
                ref,
                'error',
                unknown.length ? `Nicht als aktualisierbar gelistet: ${unknown.join(', ')}` : 'Keine Pakete angegeben',
            );
            return;
        }
        const names = packages.map(p => p.name).join(', ');
        this.log.warn(`Upgrade of OS packages ${names} on request of ${by} (fleet management)`);
        await this.reply(ref, 'running', `apt: ${names}`);
        // js-controller runs apt (with sudo if it is not root) and answers when it is through
        const answer = (await Promise.race([
            this.sendToHostAsync(host, 'upgradeOsPackages', {
                packages: packages.map(p => ({ name: p.name })),
                restart: !!req?.restart,
            }),
            new Promise(resolve => {
                this.timers.push(
                    setTimeout(
                        () => resolve({ error: 'Keine Antwort von js-controller nach 30 Minuten' }),
                        30 * 60_000,
                    ),
                );
            }),
        ])) as { success?: boolean; error?: string } | undefined;
        if (answer?.success) {
            this.log.info(`OS packages upgraded: ${names}`);
            await this.reply(
                ref,
                'done',
                `${packages.length} ${packages.length === 1 ? 'Paket' : 'Pakete'} aktualisiert${req?.restart ? ', ioBroker startet neu' : ''}`,
            );
            this.inventorySoon();
        } else {
            const error = answer?.error || 'js-controller meldet einen Fehler';
            this.log.warn(`OS upgrade failed: ${error}`);
            await this.reply(ref, 'error', error);
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
        if (this.config.allowConsole === true && findScript()) {
            kinds.push('console');
        }
        return kinds;
    }

    /** One shell for a stream of a console session, at most MAX_SHELLS at the same time */
    private openShell(t: TunnelRequest, stream: Duplex): void {
        const running = this.shells.get(t.id) ?? 0;
        if (running >= MAX_SHELLS) {
            stream.end(
                Buffer.concat([
                    consoleMessage(CONSOLE.DATA, Buffer.from(`Höchstens ${MAX_SHELLS} Shells je Sitzung.\r\n`)),
                    consoleMessage(CONSOLE.EXIT, Buffer.from('zu viele Shells')),
                ]),
            );
            return;
        }
        this.shells.set(t.id, running + 1);
        void this.updateAccessStates();
        startShell(stream, {
            cwd: join(utils.controllerDir, '..', '..'),
            log: this.log,
            by: t.by,
            onEnd: () => {
                const n = (this.shells.get(t.id) ?? 1) - 1;
                if (n > 0) {
                    this.shells.set(t.id, n);
                } else {
                    this.shells.delete(t.id);
                }
                if (!this.unloading) {
                    void this.updateAccessStates();
                }
            },
        });
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
        const isConsole = t.kind === 'console';
        if (!this.allowedAccess().includes(t.kind)) {
            refusal = !isConsole
                ? `Fernzugriff auf ${ACCESS_LABEL[t.kind]} ist am Gerät abgeschaltet`
                : this.config.allowConsole === true
                  ? 'Die Konsole braucht Linux mit script (util-linux)'
                  : 'Die Konsole ist am Gerät nicht freigegeben';
        } else if (isConsole) {
            if (this.tunnels.size >= 4) {
                refusal = 'Zu viele gleichzeitige Fernzugriffe auf dem Gerät';
            }
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
            ...(isConsole && !refusal ? { handler: (stream: Duplex) => this.openShell(t, stream) } : {}),
            refusal,
            ca: trustedCas(this.creds?.ca || ''),
            log: this.log,
            onEnd: (c, reason) => {
                if (this.tunnels.get(t.id) === c) {
                    this.tunnels.delete(t.id);
                    this.shells.delete(t.id);
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
                `Remote access to ${ACCESS_LABEL[t.kind]}${target ? ` (${target.instance})` : ''} ${resumed ? 'resumed' : 'opened'} by ${t.by} until ${new Date(t.expiresAt).toLocaleTimeString()}: ${t.purpose}`,
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

    /** " (2 Shells offen)" for a console */
    private shellText(t: TunnelRequest): string {
        if (t.kind !== 'console') {
            return '';
        }
        const n = this.shells.get(t.id) ?? 0;
        return n ? ` (${n} ${n === 1 ? 'Shell' : 'Shells'} offen)` : '';
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
                        `${ACCESS_LABEL[t.kind]}${t.instance ? ` (${t.instance})` : ''}${this.shellText(t)}: ${t.by}, ${t.purpose} (bis ${new Date(t.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
                )
                // in the settings an empty value would show the label alone
                .join('; ') || 'keiner',
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
        if (inv.remoteAccess.includes('console')) {
            inv.consoleUser = consoleUser();
        }
        inv.commands = supportedCommands(inv.software.jsController);
        if (inv.commands.includes('osUpgrade')) {
            const updates = osUpdatesFrom(
                await this.getForeignStateAsync(`system.host.${this.host}.osPackageUpdates`),
                existsSync(REBOOT_REQUIRED),
            );
            if (updates) {
                inv.osUpdates = updates;
            }
        }
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

    /**
     * Enabled instances with a process of their own on this host and whether they run
     *
     * @param adapter only of this adapter; missing: all
     */
    private async instancesOf(adapter?: string): Promise<{ id: string; alive: boolean }[]> {
        const prefix = adapter ? `system.adapter.${adapter}.` : 'system.adapter.';
        const res = await this.getObjectViewAsync('system', 'instance', {
            startkey: prefix,
            endkey: `${prefix}香`,
        });
        const list: { id: string; alive: boolean }[] = [];
        for (const row of res.rows) {
            const obj = row.value;
            if (!obj?.common.enabled || obj.common.host !== this.host) {
                continue;
            }
            // scheduled instances are not running permanently, and for files for web nothing runs at all
            if (obj.common.mode !== 'daemon' || onlyWww(obj)) {
                continue;
            }
            const alive = await instanceRunning(
                obj,
                id => this.getForeignStateAsync(id),
                () => this.webInstances(),
            );
            list.push({ id: obj._id.replace('system.adapter.', ''), alive });
        }
        return list;
    }

    /** Enabled web instances, e.g. ["web.0"], for web extensions that run in every one of them */
    private async webInstances(): Promise<string[]> {
        const res = await this.getObjectViewAsync('system', 'instance', {
            startkey: 'system.adapter.web.',
            endkey: 'system.adapter.web.香',
        });
        return res.rows.filter(r => r.value?.common.enabled).map(r => r.id.replace('system.adapter.', ''));
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
        const key = `${d.profile.hash}:${d.retry}`;
        // a package with the version number of what is installed: once per job, never in a loop
        const from =
            this.persisted.results[key] === 'done'
                ? undefined
                : Object.fromEntries(Object.entries(inv.software.adapters).map(([n, a]) => [n, a.installedFrom]));
        const plan = computePlan(d, installed, this.name, from, process.version);
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
        const nodeTarget = plan.find(s => s.action === 'node')?.to ?? undefined;

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
                nodeMajor: nodeTarget ? Number(nodeTarget) : undefined,
            }),
            nodeErrors: nodeTarget
                ? { target: nodeTarget, errors: await this.nodeErrors(nodeTarget, inv, plan) }
                : undefined,
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
        // packages of the server for single assets: loaded before anything changes
        const files: Record<string, string> = {};
        for (const [adapter, tarball] of Object.entries(packagesOf(d, plan))) {
            try {
                files[adapter] = await ensurePackage(join(this.dataDir, 'packages'), tarball, {
                    serverUrls: [this.config.enrollUrl, this.creds?.mqttUrl || ''],
                    ca: trustedCas(this.creds?.ca || ''),
                });
            } catch (e) {
                const reason = `Paket für ${adapter} nicht ladbar: ${e.message}`;
                this.log.warn(reason);
                if (reason !== this.lastWaitReason) {
                    this.lastWaitReason = reason;
                    await this.report('waiting', reason, plan);
                }
                return;
            }
        }
        this.lastWaitReason = '';
        this.log.info(`Starting job for ${d.profile.name}: ${plan.map(s => `${s.action} ${s.adapter}`).join(', ')}`);
        await this.report('preflight', `${plan.length} Schritte geplant, Vorprüfung bestanden`, plan);
        await this.jobs!.start(d, plan, this.config.backupBeforeUpdate !== false, files);
    }

    /**
     * Why Node.js cannot go to the major line: the system, and installed packages that exclude it
     * (those the plan changes are checked with their new version by checkDependencies)
     *
     * @param target major line
     * @param inv inventory
     * @param plan steps of the job
     */
    private async nodeErrors(target: string, inv: Inventory, plan: JobStep[]): Promise<string[]> {
        const changed = new Set(plan.map(s => s.adapter));
        const names = ['js-controller', ...Object.keys(inv.software.adapters).filter(n => !changed.has(n))];
        return [
            ...nodeBlockers(await nodeFacts(inv.backup.offDevice)),
            ...engineConflicts(Number(target), readEngines(join(utils.controllerDir, '..', '..'), names)),
        ];
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
