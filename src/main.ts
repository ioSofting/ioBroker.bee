import * as utils from '@iobroker/adapter-core';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import { basename, join } from 'node:path';
import type { Duplex } from 'node:stream';
import {
    ACTION_DONE,
    chooseAdminInstance,
    chooseOsPackages,
    controllerRefusal,
    instanceRefusal,
    osUpdatesFrom,
    REBOOT_REQUIRED,
    REPO_TIMEOUT,
    supportedCommands,
} from './lib/commands';
import { aiAccess, aiUserId, AiAccessManager, type McpClient } from './lib/ai';
import { aptFailure, aptUpdateArgs, aptUpgradeArgs, hasAptGet, runApt } from './lib/apt';
import { Monitor, monitorText, validRules } from './lib/monitor';
import { backupPath, OWN_BACKUPS_KEEP, pruneOwnBackups, recentOffDeviceBackup } from './lib/backup';
import { consoleUser, findScript, MAX_SHELLS, startShell } from './lib/console';
import {
    findGateway,
    gatewayText,
    KnxConnector,
    MAX_KNX_STREAMS,
    parseGateway,
    type KnxGateway,
    type KnxTransport,
} from './lib/knx';
import { addressRefusal, lanInfo, MAX_LAN_STREAMS, ownNetworks, relayTcp, targetRefusal } from './lib/lan';
import { instanceRunning, onlyWww } from './lib/instances';
import { enroll } from './lib/enrollment';
import {
    adaptersFromInstalled,
    collectHosts,
    HostExec,
    hostCommands,
    logFileData,
    MAX_REMOTE_LOG_BYTES,
    remoteLogFiles,
} from './lib/hosts';
import {
    collectInventory,
    cpuTemperature,
    describeInstance,
    diskInfo,
    installedVersions,
    packageVersion,
    sdWrites,
} from './lib/inventory';
import { executeStep, type CallResult, type StepHost } from './lib/steps';
import { JobManager, type JobFile } from './lib/jobs';
import { findLogFile, listLogFiles, logDirs, readConfig, uploadLog } from './lib/logs';
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
import { repoCatalog, repoInfo, type RepoCatalog } from './lib/repo';
import {
    normalizeComment,
    PROTOCOL_VERSION,
    type AccessKind,
    type AgentCommand,
    type ControlMessage,
    type DesiredMessage,
    type EnrollResponse,
    type HostInventory,
    type Inventory,
    type JobMessage,
    type JobState,
    type JobStep,
    type McpReply,
    type McpRequest,
    type ReplyMessage,
    type ResultMessage,
    type StateMessage,
    type LanTarget,
    type TunnelRequest,
} from './lib/protocol';
import {
    ACCESS_LABEL,
    chooseTarget,
    describeTargets,
    visProjects,
    findTargets,
    trustedTunnelUrl,
    TunnelClient,
    type AccessTarget,
} from './lib/remote';
import { Transport, trustedCas } from './lib/transport';
import { CONSOLE, consoleMessage, metaPort, type TunnelStream } from './lib/tunnel';
import { diffFlat, flatten, readJson, sleep, writeJsonAtomic } from './lib/util';
import {
    adapterCommandPaths,
    adapterCommandState,
    adapterRefusal,
    adapterStep,
    clearAdapterCommand,
    startAdapterCommand,
} from './lib/adapterCommand';
import {
    softwarePlan,
    softwareRefusal,
    validAdapterName,
    type SoftwareContext,
    type SoftwareInstance,
} from './lib/softwareCommand';

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
    /** KNX for ETS from afar (off unless the owner switches it on); the gateway, empty: from the adapter knx */
    allowKnx: boolean;
    knxGateway: string;
    knxTransport: KnxTransport;
    /**
     * Devices in the network (a LOGO!, an S7) for their tools from afar, off unless the owner switches it on; the
     * networks (empty: the own subnets) and the ports (empty: any). The networks also bound the KNX gateways the
     * fleet management names besides the one above.
     */
    allowLan: boolean;
    lanNetworks: string;
    lanPorts: string;
    /** AI access: the MCP server of ioBroker for an AI of the fleet management (off unless the owner allows it) */
    allowAi: boolean;
    /** ...with writing states, with changing objects and files; as this ioBroker user */
    aiSetState: boolean;
    aiObjectChange: boolean;
    aiUser: string;
    windowStart: string;
    windowEnd: string;
    ignoreWindow: boolean;
    conditions: Condition[];
    /** Monitoring: rules on states, reported to the fleet management (table "Überwachung") */
    monitors: unknown;
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
    /** Backups the agent made itself before jobs, oldest first; it keeps OWN_BACKUPS_KEEP of them */
    ownBackups?: string[];
    notified: Record<string, number>;
}

/** Host of the broker for the status, e.g. "beekeeper.one" */
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
    /** Monitoring of states (lib/monitor); null without rules */
    private monitor: Monitor | null = null;
    private monitorSendTimer: NodeJS.Timeout | null = null;
    private uuid = '';
    private errorLog: { ts: number; from: string; message: string }[] = [];
    private errorsSinceHeartbeat = 0;
    private reconciling = false;
    /** A command of the fleet management is being carried out (one at a time) */
    private commandRunning = false;
    /** Waits for the runner of the command 'adapter' (also one started before a restart of the agent) */
    private adapterWaiting = false;
    /** AI access (command 'mcp') */
    private ai: AiAccessManager | null = null;
    private logUploading = false;
    /** The repositories set in admin: read on start and when admin loads them again */
    private repos: RepoCatalog | undefined;
    private activeRepoKey = '';
    private lastWaitReason = '';
    private unloading = false;
    /** Open remote access sessions by session id */
    private readonly tunnels = new Map<string, TunnelClient>();
    /** Running shells of the console per session */
    private readonly shells = new Map<string, number>();
    /** Connections of ETS per KNX session */
    private readonly knxStreams = new Map<string, number>();
    /** The other hosts of the system as last collected, by name */
    private readonly knownHosts = new Map<string, HostInventory>();
    /** The CLI on the other hosts of the system */
    private readonly hostExec = new HostExec((host, command, message) =>
        this.sendToHost(host, command, message as ioBroker.MessagePayload),
    );

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        // messages to the agent: the output of the CLI on the other hosts (cmdExec)
        const ref: { adapter?: BeeAdapter } = {};
        super({ ...options, name: 'bee', message: obj => void ref.adapter?.hostExec.onMessage(obj) });
        ref.adapter = this;
        this.on('ready', () => this.onReady());
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
        this.on('objectChange', (id, obj) => void this.onObjectChange(id, obj));
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
            installed: async () => installedVersions(await this.inventory(false)),
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
        await this.startMonitor();
        // the repositories of admin, for the updates of the adapters in the fleet management
        await this.subscribeForeignObjectsAsync('system.repositories');
        await this.subscribeForeignObjectsAsync('system.config');
        await this.readRepos();
        await this.updateInfoStates();
        this.ai = new AiAccessManager({
            settings: this.config,
            nodeVersion: process.versions.node,
            create: settings => this.startMcp(settings),
            log: this.log,
            onChange: () => void this.updateAccessStates(),
        });

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
            this.hostExec.stop();
            if (this.enrollTimer) {
                clearTimeout(this.enrollTimer);
            }
            // the sessions stay in tunnels.json and are resumed after the restart
            for (const client of [...this.tunnels.values()]) {
                client.stop('agent stops');
            }
            // AI sessions come back with their next request
            await Promise.race([this.ai?.stop(), new Promise(resolve => setTimeout(resolve, 500))]);
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
        // an adapter installed on request, e.g. the agent itself: the answer comes from the new process
        void this.waitAdapterCommand();
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
        } else if (
            msg.ref &&
            (msg.cmd === 'instance' ||
                msg.cmd === 'restart' ||
                msg.cmd === 'osUpgrade' ||
                msg.cmd === 'adapter' ||
                msg.cmd === 'software' ||
                msg.cmd === 'repoUpdate')
        ) {
            await this.runCommand(msg);
        } else if (msg.ref && msg.cmd === 'visProjects') {
            // only reads: also during a job or another command
            await this.visProjectsCommand(msg.ref);
        } else if (msg.ref && msg.cmd === 'logList') {
            // only reads: also during a job or another command
            await this.logListCommand(msg.ref, msg.host);
        } else if (msg.ref && msg.cmd === 'logFetch') {
            // may take minutes on a mobile connection: the other messages go on meanwhile
            void this.logFetchCommand(msg.ref, msg.by || 'Flottenverwaltung', msg.logFetch, msg.host);
        } else if (msg.ref && msg.cmd === 'mcp') {
            // the AI waits for it; independent of jobs and other commands
            void this.mcpCommand(msg.ref, msg.mcp);
        }
    }

    // ------------------------------------------------------------------ AI access

    /** Starts the MCP server of ioBroker in this process, with the rights the owner gives */
    private async startMcp(settings: {
        aiUser: string;
        aiSetState: boolean;
        aiObjectChange: boolean;
    }): Promise<McpClient> {
        const user = aiUserId(settings.aiUser);
        if (!user || !(await this.getForeignObjectAsync(user))) {
            throw new Error(`ioBroker-Nutzer ${settings.aiUser} gibt es nicht`);
        }
        const { createInProcessMcp } = await import('@iobroker/mcp-server');
        const mcp = await createInProcessMcp({
            adapter: this,
            defaultUser: user,
            language: this.language || 'en',
            allowSetState: settings.aiSetState === true,
            setStateDestructive: true,
            allowObjectChange: settings.aiObjectChange === true,
            allowInstanceControl: false,
            allowAdapterManagement: false,
            allowPackageInstall: false,
            allowScriptChange: false,
            sendToAllowlist: '',
            // the person opened the session in the fleet management; the AI client asks its user itself
            confirmDangerous: false,
            clientName: 'ioBroker.bee',
            clientVersion: this.version || '',
        });
        this.log.info(`MCP server of ioBroker started for the AI access, as ${user}`);
        return mcp;
    }

    private async mcpCommand(ref: string, req: McpRequest | undefined): Promise<void> {
        try {
            if (!this.ai) {
                throw new Error('Der Agent startet noch');
            }
            const mcp = await this.ai.handle(req);
            await this.reply(ref, 'done', undefined, undefined, mcp);
        } catch (e) {
            // e.g. the MCP server does not start: the person opening the session reads why, and may try again
            this.log.debug(`AI request refused: ${e.message}`);
            await this.reply(ref, 'error', e.message);
        }
    }

    // ------------------------------------------------------------------ commands of the fleet management

    private async reply(
        ref: string,
        state: ReplyMessage['state'],
        message?: string,
        files?: ReplyMessage['files'],
        mcp?: McpReply,
    ): Promise<void> {
        const msg: ReplyMessage = {
            v: PROTOCOL_VERSION,
            ts: Date.now(),
            ref,
            state,
            ...(message ? { message } : {}),
            ...(files ? { files } : {}),
            ...(mcp ? { mcp } : {}),
        };
        await this.transport?.publish('reply', msg);
    }

    /** Directories of the log files of ioBroker (file transports of iobroker.json) */
    private logDirs(): string[] {
        let config: unknown = null;
        try {
            config = readConfig(utils.controllerDir);
        } catch (e) {
            this.log.warn(`iobroker.json not readable: ${e.message}`);
        }
        return logDirs(config, join(utils.controllerDir, '..', '..'));
    }

    // ------------------------------------------------------------------ other hosts of the system

    /**
     * Sends a host command and waits for the answer
     *
     * @param host name of the host
     * @param command host command of js-controller
     * @param message its message
     * @param timeoutMs longest wait
     * @returns undefined if no answer came in time
     */
    private sendHost(host: string, command: string, message: unknown, timeoutMs: number): Promise<unknown> {
        return new Promise(resolve => {
            const timer = setTimeout(() => resolve(undefined), timeoutMs);
            this.sendToHost(`system.host.${host}`, command, message as ioBroker.MessagePayload, answer => {
                clearTimeout(timer);
                resolve(answer);
            });
        });
    }

    private async hostAlive(host: string): Promise<boolean> {
        return !!(await this.getForeignStateAsync(`system.host.${host}.alive`))?.val;
    }

    /**
     * The host a command is for: the own one, or another host of the system that runs
     *
     * @param host JobMessage.host
     * @param command the command, one of HostInventory.commands of that host
     * @returns the name and whether it is another host, or why not
     */
    private async targetHost(
        host: unknown,
        command: AgentCommand,
    ): Promise<{ name: string; remote: boolean; refusal?: undefined } | { refusal: string }> {
        if (host === undefined || host === null || host === '' || host === this.host) {
            return { name: this.host || '', remote: false };
        }
        if (typeof host !== 'string' || !/^[\w.-]{1,100}$/.test(host)) {
            return { refusal: 'Ungültiger Host' };
        }
        const obj = await this.getForeignObjectAsync(`system.host.${host}`);
        if (obj?.type !== 'host') {
            return { refusal: `Den Host ${host} gibt es im System nicht` };
        }
        if (!(await this.hostAlive(host))) {
            return { refusal: `Der Host ${host} ist offline` };
        }
        const known = this.knownHosts.get(host);
        if (known && !known.commands.includes(command)) {
            return { refusal: `Auf dem Host ${host} nicht möglich` };
        }
        return { name: host, remote: true };
    }

    /** Version of an adapter whose package is on another host; null if none */
    private async remoteVersion(host: string, adapter: string): Promise<string | null> {
        const adapters = adaptersFromInstalled(await this.sendHost(host, 'getInstalled', null, 60_000));
        if (!adapters) {
            throw new Error(`Der Host ${host} sagt nicht, was installiert ist`);
        }
        return adapters[adapter]?.version ?? null;
    }

    /**
     * Runs a step on another host with its js-controller (cmdExec), as the runner does here, and answers the server
     *
     * @param ref reference of the command
     * @param host the other host
     * @param step the step
     * @param texts what the answers say
     * @param texts.what e.g. "frigate 3.3.0"
     * @param texts.done the answer when it worked
     * @param pkg local package (tgz) of the server instead of npm
     */
    private async remoteStep(
        ref: string,
        host: string,
        step: JobStep,
        texts: { what: string; done: string },
        pkg?: string,
    ): Promise<void> {
        if (this.control?.halt) {
            await this.reply(ref, 'error', `${texts.what}: durch Not-Aus angehalten`);
            return;
        }
        let files: { name: string; file: string }[] | undefined;
        const name = pkg ? basename(pkg) : undefined;
        if (pkg) {
            const feature = (await this.sendHost(
                host,
                'checkFeatureSupported',
                'CONTROLLER_CMD_EXEC_FILES',
                10_000,
            )) as { result?: boolean } | undefined;
            if (!feature?.result) {
                await this.reply(
                    ref,
                    'error',
                    `${texts.what}: js-controller auf ${host} kann keine Pakete annehmen (zu alt); aus npm installieren`,
                );
                return;
            }
            files = [{ name: name!, file: (await readFile(pkg)).toString('base64') }];
        }
        const runner: StepHost = {
            run: args => {
                this.log.info(`${host}: iobroker ${args.join(' ')}`);
                return this.hostExec.run(host, args, name && args.includes(name) ? files : undefined);
            },
            installed: adapter => this.remoteVersion(host, adapter),
            note: text => this.log.info(`${host}: ${text}`),
        };
        let result: CallResult & { mismatch: string | null };
        try {
            result = await executeStep(step, runner, name);
        } catch (e) {
            result = { code: 1, output: e.message, mismatch: null };
        }
        if (result.code === 0 && !result.mismatch) {
            this.log.info(`${host}: ${texts.done}`);
            await this.reply(ref, 'done', `${texts.done} (Host ${host})`);
        } else {
            const lines = result.output
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(Boolean)
                .slice(-6)
                .join(' | ');
            const reason = result.mismatch ?? `fehlgeschlagen (Exit-Code ${result.code})`;
            this.log.warn(`${host}: ${texts.what}: ${reason}: ${lines}`);
            await this.reply(
                ref,
                'error',
                `${texts.what} auf ${host}: ${reason}${lines ? `: ${lines}` : ''}`.slice(0, 1000),
            );
        }
        this.inventorySoon();
    }

    private async logListCommand(ref: string, host?: string): Promise<void> {
        try {
            const target = await this.targetHost(host, 'logs');
            if (target.refusal !== undefined) {
                throw new Error(target.refusal);
            }
            if (target.remote) {
                const answer = await this.sendHost(target.name, 'getLogFiles', null, 30_000);
                if (!answer) {
                    throw new Error(`Keine Antwort von ${target.name}`);
                }
                const files = remoteLogFiles(answer, target.name).map(({ name, size, mtime }) => ({
                    name,
                    size,
                    mtime,
                }));
                await this.reply(ref, 'done', `${files.length} Log-Dateien auf ${target.name}`, files);
                return;
            }
            const dirs = this.logDirs();
            const files = await listLogFiles(dirs);
            await this.reply(ref, 'done', `${files.length} Log-Dateien in ${dirs.join(', ')}`, files);
        } catch (e) {
            await this.reply(ref, 'error', e.message);
        }
    }

    /** The projects of vis-2 right now, for the remote access of the fleet management */
    private async visProjectsCommand(ref: string): Promise<void> {
        const projects = await visProjects(this);
        const msg: ReplyMessage = {
            v: PROTOCOL_VERSION,
            ts: Date.now(),
            ref,
            state: 'done',
            message: `${projects.length} Projekte in vis-2`,
            projects,
        };
        await this.transport?.publish('reply', msg);
    }

    /** Uploads a log file to the own server, one at a time */
    /** A log file of another host, as it is */
    private async remoteLog(host: string, name: unknown): Promise<{ name: string; data: Buffer }> {
        const list = remoteLogFiles(await this.sendHost(host, 'getLogFiles', null, 30_000), host);
        const entry = list.find(f => f.name === name);
        if (!entry) {
            throw new Error(`Log-Datei ${String(name)} gibt es auf ${host} nicht`);
        }
        if (entry.size > MAX_REMOTE_LOG_BYTES) {
            throw new Error(
                `${entry.name} ist größer als ${MAX_REMOTE_LOG_BYTES / 1024 / 1024} MB: von einem anderen Host nicht übertragbar`,
            );
        }
        const answer = await this.sendHost(
            host,
            'getLogFile',
            { transport: entry.transport, filename: entry.name },
            120_000,
        );
        if (answer === undefined) {
            throw new Error(`Keine Antwort von ${host}`);
        }
        return { name: entry.name, data: logFileData(answer) };
    }

    private async logFetchCommand(ref: string, by: string, req: JobMessage['logFetch'], host?: string): Promise<void> {
        let mine = false;
        try {
            if (this.logUploading) {
                throw new Error('Es wird schon eine Log-Datei übertragen');
            }
            this.logUploading = mine = true;
            if (!req || typeof req.url !== 'string' || typeof req.ticket !== 'string') {
                throw new Error('Unvollständige Anfrage');
            }
            if (!trustedPackageUrl(req.url, [this.config.enrollUrl, this.creds?.mqttUrl || ''])) {
                throw new Error(`${req.url} gehört nicht zum Flottenserver`);
            }
            const target = await this.targetHost(host, 'logs');
            if (target.refusal !== undefined) {
                throw new Error(target.refusal);
            }
            const file = target.remote
                ? await this.remoteLog(target.name, req.file)
                : await findLogFile(this.logDirs(), req.file);
            if (!file) {
                throw new Error(`Log-Datei ${String(req.file)} gibt es nicht`);
            }
            this.log.info(
                `Log file ${req.file}${target.remote ? ` of ${target.name}` : ''} is uploaded on request of ${by} (fleet management)`,
            );
            await this.reply(ref, 'running', `${req.file} wird komprimiert übertragen`);
            const bytes = await uploadLog(file, req.url, req.ticket, trustedCas(this.creds?.ca || ''));
            await this.reply(ref, 'done', `${req.file}: ${(bytes / 1024 / 1024).toFixed(1)} MB übertragen`);
        } catch (e) {
            this.log.warn(`Log file ${String(req?.file)} for ${by}: ${e.message}`);
            await this.reply(ref, 'error', e.message);
        } finally {
            if (mine) {
                this.logUploading = false;
            }
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
        if (this.commandRunning || (await adapterCommandState(adapterCommandPaths(this.dataDir))) === null) {
            await this.reply(ref, 'error', 'Es läuft schon ein Befehl');
            return;
        }
        this.commandRunning = true;
        try {
            const target = await this.targetHost(msg.host, msg.cmd as AgentCommand);
            if (target.refusal !== undefined) {
                await this.reply(ref, 'error', target.refusal);
                return;
            }
            const remote = target.remote ? target.name : null;
            if (msg.cmd === 'instance') {
                await this.instanceCommand(ref, by, msg.instance, target.name);
            } else if (msg.cmd === 'restart') {
                this.log.warn(
                    `Restart of ioBroker${remote ? ` on ${remote}` : ''} on request of ${by} (fleet management)`,
                );
                // the answer goes out first, the restart of the own host takes the agent down too
                await this.reply(ref, 'done', remote ? `ioBroker auf ${remote} startet neu` : 'ioBroker startet neu');
                this.sendToHost(`system.host.${target.name}`, 'restartController', {});
                if (remote) {
                    this.inventorySoon();
                }
            } else if (msg.cmd === 'osUpgrade') {
                await this.osUpgradeCommand(ref, by, msg.osUpgrade, target.name);
            } else if (msg.cmd === 'adapter') {
                await this.adapterCommand(ref, by, msg.adapter, remote);
            } else if (msg.cmd === 'software') {
                await this.softwareCommand(ref, by, msg.software, remote);
            } else if (msg.cmd === 'repoUpdate') {
                await this.repoUpdateCommand(ref, by, remote);
            } else if (msg.cmd === 'controller') {
                await this.controllerCommand(ref, by, msg.controller, target.name);
            }
        } catch (e) {
            this.log.warn(`Command ${msg.cmd} of ${by} failed: ${e.message}`);
            await this.reply(ref, 'error', e.message);
        } finally {
            this.commandRunning = false;
        }
    }

    /**
     * Upgrades js-controller of this or another host, as admin does it: js-controller starts its upgrade manager as a
     * process of its own, which stops ioBroker (with this agent on the own host), installs the version with npm and
     * starts ioBroker again. The answer is "running"; the server sees the outcome in the version of the next inventory.
     *
     * @param ref reference of the command
     * @param by who asked
     * @param req the version
     * @param hostName the host
     */
    private async controllerCommand(
        ref: string,
        by: string,
        req: JobMessage['controller'],
        hostName: string,
    ): Promise<void> {
        const remote = hostName !== this.host;
        const hostObj = await this.getForeignObjectAsync(`system.host.${hostName}`);
        const installed = String(hostObj?.common?.installedVersion || '');
        const platform = remote ? this.knownHosts.get(hostName)?.system?.platform || '' : process.platform;
        const refusal = controllerRefusal(req, installed, platform);
        if (refusal) {
            await this.reply(ref, 'error', refusal);
            return;
        }
        const version = req!.version;
        const admins = await this.getObjectViewAsync('system', 'instance', {
            startkey: 'system.adapter.admin.',
            endkey: 'system.adapter.admin.香',
        });
        const adminInstance = chooseAdminInstance(
            admins.rows.map(r => r.value),
            hostName,
        );
        if (adminInstance === null) {
            await this.reply(
                ref,
                'error',
                'Das Update von js-controller braucht eine Instanz von admin: auf ihrem Port zeigt js-controller den Fortschritt',
            );
            return;
        }
        this.log.warn(
            `Upgrade of js-controller${remote ? ` on ${hostName}` : ''} from ${installed} to ${version} on request of ${by} (fleet management)`,
        );
        const answer = (await this.sendHost(hostName, 'upgradeController', { version, adminInstance }, 60_000)) as
            { result?: boolean } | undefined;
        if (!answer?.result) {
            await this.reply(
                ref,
                'error',
                answer === undefined
                    ? 'js-controller hat nicht geantwortet'
                    : 'js-controller kann sich hier nicht selbst aktualisieren (etwa in Docker ohne das offizielle Image)',
            );
            return;
        }
        // the answer goes out first: on the own host the upgrade manager stops ioBroker with this agent in a moment
        await this.reply(
            ref,
            'running',
            `js-controller ${version} wird installiert; ioBroker${remote ? ` auf ${hostName}` : ''} ist dabei einige Minuten nicht erreichbar`,
        );
        if (remote) {
            // the inventory of the other hosts shows the new version once it runs again
            for (const ms of [3, 6, 10, 15, 20].map(m => m * 60_000)) {
                this.timers.push(setTimeout(() => void this.sendInventory(false), ms));
            }
        }
    }

    /**
     * Loads the active adapter repositories again, as admin does with "update adapter list": js-controller of the own
     * host downloads them, keeps them in system.repositories and checks for OS updates on the way. The repositories
     * are the same for every host of the system.
     */
    private async repoUpdateCommand(ref: string, by: string, remote: string | null): Promise<void> {
        if (remote) {
            await this.reply(ref, 'error', 'Die Repositories gelten für das ganze System: ohne Host aufrufen');
            return;
        }
        const config = await this.getForeignObjectAsync('system.config');
        const active: unknown = config?.common?.activeRepo;
        const names = (Array.isArray(active) ? active : [active]).filter(
            (n): n is string => typeof n === 'string' && !!n,
        );
        if (!names.length) {
            await this.reply(ref, 'error', 'In admin ist kein Repository aktiv');
            return;
        }
        this.log.info(`Repositories ${names.join(', ')} loaded again on request of ${by} (fleet management)`);
        await this.reply(ref, 'running', `Repository ${names.join(', ')} wird geladen`);
        const answer = await this.sendHost(
            this.host || '',
            'getRepository',
            { repo: names, update: true },
            REPO_TIMEOUT,
        );
        const count = answer && typeof answer === 'object' && !Array.isArray(answer) ? Object.keys(answer).length : 0;
        await this.readRepos();
        await this.sendInventory(false);
        if (!count) {
            await this.reply(
                ref,
                'error',
                answer === undefined
                    ? `js-controller hat nach ${REPO_TIMEOUT / 1000} s nicht geantwortet`
                    : 'js-controller hat kein Repository geliefert: Log von ioBroker ansehen (Download fehlgeschlagen?)',
            );
            return;
        }
        await this.reply(ref, 'done', `Repository ${names.join(', ')} geladen: ${count} Adapter`);
    }

    /** Start, stop or restart an instance of a host, the same way admin does it */
    private async instanceCommand(ref: string, by: string, req: JobMessage['instance'], host: string): Promise<void> {
        const id = req?.id;
        const action = req?.action;
        const objId = `system.adapter.${id}`;
        const obj = typeof id === 'string' && /^[\w.-]+$/.test(id) ? await this.getForeignObjectAsync(objId) : null;
        const refusal = instanceRefusal(id, action, this.namespace, obj, host);
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

    /**
     * Installs one version of one adapter right away, for an asset without desired profile
     *
     * @param ref reference of the command
     * @param by who asked
     * @param req the request
     * @param remote another host of the system to install it on; null: this host
     */
    private async adapterCommand(
        ref: string,
        by: string,
        req: JobMessage['adapter'],
        remote: string | null,
    ): Promise<void> {
        const refusal = adapterRefusal(req, this.desired);
        if (refusal || !req) {
            await this.reply(ref, 'error', refusal || 'Adapter fehlt');
            return;
        }
        if (remote && req.name === this.name) {
            await this.reply(ref, 'error', `${this.name} läuft nur auf dem Host ${this.host}`);
            return;
        }
        // what is on the host: the objects are the same for all hosts of the system
        const installed = remote
            ? ((await this.remoteVersion(remote, req.name)) ?? undefined)
            : (packageVersion(join(utils.controllerDir, '..'), req.name) ?? undefined);
        let file: string | undefined;
        if (req.tarball) {
            await this.reply(ref, 'running', `Paket für ${req.name} wird geladen`);
            file = await ensurePackage(join(this.dataDir, 'packages'), req.tarball, {
                serverUrls: [this.config.enrollUrl, this.creds?.mqttUrl || ''],
                ca: trustedCas(this.creds?.ca || ''),
            });
        }
        const step = adapterStep(req.name, req.version, installed, !!file);
        if (!step) {
            await this.reply(ref, 'done', `${req.name} ${req.version} ist schon installiert`);
            return;
        }
        this.log.info(
            `Adapter ${req.name}${remote ? ` on ${remote}` : ''}: ${step.action} ${installed ?? '-'} -> ${req.version} on request of ${by} (fleet management)`,
        );
        const running = installed
            ? `${req.name} ${installed} → ${req.version} wird installiert`
            : `${req.name} ${req.version} wird installiert`;
        if (remote) {
            await this.reply(ref, 'running', `${running} (Host ${remote})`);
            const what = `${req.name} ${req.version}`;
            await this.remoteStep(ref, remote, step, { what, done: `${what} installiert` }, file);
            return;
        }
        await startAdapterCommand(
            adapterCommandPaths(this.dataDir),
            { ref, by, name: req.name, version: req.version, startedAt: Date.now() },
            step,
            {
                iobrokerJs: join(utils.controllerDir, 'iobroker.js'),
                cwd: join(utils.controllerDir, '..', '..'),
                haltFile: join(this.dataDir, 'halt'),
                logFile: join(this.dataDir, 'runner.log'),
                file,
            },
        );
        await this.reply(ref, 'running', running);
        await this.waitAdapterCommand();
    }

    /**
     * The hosts of the system the package of an adapter is on: this host and the target asked now, the others as
     * last collected
     *
     * @param adapter name of the adapter
     * @param remote another host the command is for; null: this host
     */
    private async hostsWithPackage(adapter: string, remote: string | null): Promise<string[]> {
        const hosts = [...this.knownHosts.values()]
            .filter(h => h.name !== remote && h.adapters?.[adapter])
            .map(h => h.name);
        if (remote && (await this.remoteVersion(remote, adapter))) {
            hosts.unshift(remote);
        }
        if (packageVersion(join(utils.controllerDir, '..'), adapter)) {
            hosts.unshift(this.host || '');
        }
        return hosts;
    }

    /** All instances of an adapter with their host */
    private async instancesWithHost(adapter: string): Promise<SoftwareInstance[]> {
        const prefix = `system.adapter.${adapter}.`;
        const res = await this.getObjectViewAsync('system', 'instance', { startkey: prefix, endkey: `${prefix}香` });
        return res.rows
            .filter(row => row.value)
            .map(row => ({ id: row.value._id.replace('system.adapter.', ''), host: String(row.value.common.host) }));
    }

    /**
     * Removes an adapter, adds or deletes an instance right away, with the runner of the command 'adapter'
     *
     * @param ref reference of the command
     * @param by who asked
     * @param req the request
     * @param remote another host of the system to do it on; null: this host
     */
    private async softwareCommand(
        ref: string,
        by: string,
        req: JobMessage['software'],
        remote: string | null,
    ): Promise<void> {
        const adapter = validAdapterName(req?.adapter) ? req.adapter : null;
        const host = remote ?? (this.host || '');
        const ctx: SoftwareContext = {
            own: this.namespace,
            host,
            desired: this.desired,
            adapterObj: adapter ? await this.getForeignObjectAsync(`system.adapter.${adapter}`) : null,
            instances: adapter ? await this.instancesWithHost(adapter) : [],
            // an instance belongs to a host, whatever is installed where
            installedOn:
                adapter && req?.action !== 'removeInstance' ? await this.hostsWithPackage(adapter, remote) : undefined,
        };
        const refusal = softwareRefusal(req, ctx);
        if (refusal || !req) {
            await this.reply(ref, 'error', refusal || 'Anfrage fehlt');
            return;
        }
        const plan = softwarePlan(req, ctx);
        this.log.info(
            `Software ${req.action} ${plan.what}${remote ? ` on ${remote}` : ''} on request of ${by} (fleet management)`,
        );
        if (remote) {
            await this.reply(ref, 'running', `${plan.running} (Host ${remote})`);
            await this.remoteStep(ref, remote, plan.step, { what: plan.what, done: plan.done });
            return;
        }
        await startAdapterCommand(
            adapterCommandPaths(this.dataDir),
            {
                ref,
                by,
                name: req.adapter,
                version: '',
                what: plan.what,
                done: plan.done,
                startedAt: Date.now(),
            },
            plan.step,
            {
                iobrokerJs: join(utils.controllerDir, 'iobroker.js'),
                cwd: join(utils.controllerDir, '..', '..'),
                haltFile: join(this.dataDir, 'halt'),
                logFile: join(this.dataDir, 'runner.log'),
            },
        );
        await this.reply(ref, 'running', plan.running);
        await this.waitAdapterCommand();
    }

    /** Waits for the runner of the commands 'adapter' and 'software' and answers the server */
    private async waitAdapterCommand(): Promise<void> {
        if (this.adapterWaiting || !this.dataDir) {
            return;
        }
        this.adapterWaiting = true;
        const paths = adapterCommandPaths(this.dataDir);
        try {
            while (!this.unloading) {
                const result = await adapterCommandState(paths);
                if (result === undefined) {
                    return;
                }
                if (result) {
                    if (!this.transport?.connected) {
                        // answered after the next connect
                        return;
                    }
                    await this.reply(result.command.ref, result.state, result.message);
                    this.log[result.state === 'done' ? 'info' : 'warn'](
                        `Adapter command of ${result.command.by}: ${result.message}`,
                    );
                    await clearAdapterCommand(paths);
                    this.inventorySoon();
                    return;
                }
                await sleep(2000);
            }
        } finally {
            this.adapterWaiting = false;
        }
    }

    /** Upgrade OS packages through js-controller, only those it listed itself */
    private async osUpgradeCommand(
        ref: string,
        by: string,
        req: JobMessage['osUpgrade'],
        hostName: string,
    ): Promise<void> {
        const remote = hostName !== this.host;
        const host = `system.host.${hostName}`;
        const hostObj = await this.getForeignObjectAsync(host);
        const jsController = String(hostObj?.common?.installedVersion || '');
        const supported = remote
            ? hostCommands(jsController, this.knownHosts.get(hostName)?.system?.platform || '')
            : supportedCommands(jsController);
        if (!supported.includes('osUpgrade')) {
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
        this.log.warn(
            `Upgrade of OS packages ${names}${remote ? ` on ${hostName}` : ''} on request of ${by} (fleet management)`,
        );
        await this.reply(ref, 'running', `apt${remote ? ` auf ${hostName}` : ''}: ${names}`);
        if (
            !remote &&
            hasAptGet() &&
            (await this.osUpgradeOwn(
                ref,
                packages.map(p => p.name),
                !!req?.restart,
                hostName,
            ))
        ) {
            return;
        }
        // another host, or sudo does not allow apt-get here: js-controller runs apt (with sudo if it is not root) and
        // answers when it is through
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
            const error = answer?.error
                ? aptFailure(answer.error, remote ? hostName : undefined)
                : 'js-controller meldet einen Fehler';
            this.log.warn(`OS upgrade failed: ${answer?.error || error}`);
            await this.reply(ref, 'error', error);
        }
    }

    /**
     * OS updates of the own host with apt-get (see lib/apt): package lists first, then only the chosen packages,
     * without questions
     *
     * @param ref the command
     * @param names the chosen packages
     * @param restart restart ioBroker afterwards
     * @param hostName the own host
     * @returns false if sudo does not allow apt-get here; js-controller tries then
     */
    private async osUpgradeOwn(ref: string, names: string[], restart: boolean, hostName: string): Promise<boolean> {
        const update = await runApt(aptUpdateArgs(), 10 * 60_000);
        if (update.denied) {
            this.log.info('sudo does not allow apt-get here, js-controller upgrades the packages');
            return false;
        }
        if (!update.ok) {
            // one source that fails (a repository that moved, say) does not keep the others from being read
            this.log.warn(`apt-get update: ${aptFailure(update.output)}`);
        }
        const upgrade = await runApt(aptUpgradeArgs(names), 45 * 60_000);
        if (upgrade.ok) {
            this.log.info(`OS packages upgraded: ${names.join(', ')}`);
            await this.reply(
                ref,
                'done',
                `${names.length} ${names.length === 1 ? 'Paket' : 'Pakete'} aktualisiert${update.ok ? '' : ' (nicht alle Paketlisten ließen sich aktualisieren)'}${restart ? ', ioBroker startet neu' : ''}`,
            );
        } else {
            const error = aptFailure(upgrade.output);
            this.log.warn(`OS upgrade failed: ${error}`);
            await this.reply(ref, 'error', error);
        }
        // fresh lists show other packages: js-controller lists them anew when it reads the repository
        await this.refreshOsList(hostName);
        if (upgrade.ok && restart) {
            await this.sendHost(hostName, 'restartController', null, 10_000);
        } else {
            this.inventorySoon();
        }
        return true;
    }

    /** js-controller lists the OS updates anew (apt list --upgradeable) only after it read the repository */
    private async refreshOsList(hostName: string): Promise<void> {
        const id = `system.host.${hostName}.osPackageUpdates`;
        const before = (await this.getForeignStateAsync(id))?.ts ?? 0;
        await this.sendHost(hostName, 'getRepository', { update: false }, 120_000);
        // it answers first and lists afterwards
        for (let i = 0; i < 15 && ((await this.getForeignStateAsync(id))?.ts ?? 0) <= before; i++) {
            await sleep(2_000);
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
        if (this.config.allowKnx === true) {
            kinds.push('knx');
        }
        if (this.config.allowLan === true) {
            kinds.push('lan');
        }
        return kinds;
    }

    private knxGateway(): Promise<KnxGateway | null> {
        return findGateway(this, this.config.knxGateway || '', this.config.knxTransport || 'auto');
    }

    /** One connection of ETS to the gateway, at most MAX_KNX_STREAMS at the same time */
    private openKnx(t: TunnelRequest, connector: KnxConnector, stream: Duplex): void {
        const running = this.knxStreams.get(t.id) ?? 0;
        if (running >= MAX_KNX_STREAMS) {
            stream.destroy(new Error(`Höchstens ${MAX_KNX_STREAMS} Verbindungen von ETS je Sitzung`));
            return;
        }
        this.knxStreams.set(t.id, running + 1);
        void this.updateAccessStates();
        connector.relay(stream, () => {
            const n = (this.knxStreams.get(t.id) ?? 1) - 1;
            if (n > 0) {
                this.knxStreams.set(t.id, n);
            } else {
                this.knxStreams.delete(t.id);
            }
            if (!this.unloading) {
                void this.updateAccessStates();
            }
        });
    }

    /** One connection of a tool to a device in the network, on the port its stream names */
    private openLan(t: TunnelRequest, lan: LanTarget, stream: TunnelStream): void {
        const port = metaPort(stream.meta);
        const allowed = lanInfo(this.config).ports;
        if (!port || !lan.ports.includes(port) || (allowed && !allowed.includes(port))) {
            stream.destroy(new Error(`Port ${port ?? '?'} ist für ${lan.name} nicht freigegeben`));
            return;
        }
        const running = this.knxStreams.get(t.id) ?? 0;
        if (running >= MAX_LAN_STREAMS) {
            stream.destroy(new Error(`Höchstens ${MAX_LAN_STREAMS} Verbindungen je Sitzung`));
            return;
        }
        this.knxStreams.set(t.id, running + 1);
        void this.updateAccessStates();
        relayTcp(stream, lan.host, port, error => {
            if (error) {
                this.log.info(`Remote access to ${lan.name} (${lan.host}:${port}): ${error}`);
            }
            const n = (this.knxStreams.get(t.id) ?? 1) - 1;
            if (n > 0) {
                this.knxStreams.set(t.id, n);
            } else {
                this.knxStreams.delete(t.id);
            }
            if (!this.unloading) {
                void this.updateAccessStates();
            }
        });
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
        let knx: KnxConnector | null = null;
        let lan: LanTarget | null = null;
        const isConsole = t.kind === 'console';
        if (!this.allowedAccess().includes(t.kind)) {
            refusal =
                t.kind === 'knx'
                    ? 'KNX ist am Gerät nicht freigegeben'
                    : t.kind === 'lan'
                      ? 'Geräte im Netz sind am Gerät nicht freigegeben'
                      : !isConsole
                        ? `Fernzugriff auf ${ACCESS_LABEL[t.kind]} ist am Gerät abgeschaltet`
                        : this.config.allowConsole === true
                          ? 'Die Konsole braucht Linux mit script (util-linux)'
                          : 'Die Konsole ist am Gerät nicht freigegeben';
        } else if (t.kind === 'lan') {
            // the device the server names, only inside what the owner allows here
            const own = ownNetworks();
            refusal =
                targetRefusal(t.lan, lanInfo(this.config, own), own.addresses) ??
                (this.tunnels.size >= 4 ? 'Zu viele gleichzeitige Fernzugriffe auf dem Gerät' : null);
            if (!refusal) {
                lan = t.lan!;
            }
        } else if (t.kind === 'knx') {
            // the gateway set here; another one of the list in the portal only inside the allowed network
            let gateway: KnxGateway | null = null;
            if (t.knxGateway) {
                const own = ownNetworks();
                gateway = parseGateway(t.knxGateway, this.config.knxTransport || 'auto');
                const why = gateway
                    ? addressRefusal(gateway.host, lanInfo(this.config, own), own.addresses)
                    : `${t.knxGateway} ist kein Gateway`;
                if (why) {
                    refusal = `KNX-Gateway: ${why}`;
                    gateway = null;
                }
            } else {
                gateway = await this.knxGateway();
            }
            if (refusal) {
                // said above
            } else if (!gateway) {
                refusal = 'Kein KNX-Gateway: in der Instanz bee eintragen oder den Adapter knx einrichten';
            } else if (this.tunnels.size >= 4) {
                refusal = 'Zu viele gleichzeitige Fernzugriffe auf dem Gerät';
            } else {
                knx = new KnxConnector(gateway, { log: this.log });
            }
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
            ...(knx && !refusal ? { handler: (stream: Duplex) => this.openKnx(t, knx, stream) } : {}),
            ...(lan && !refusal ? { handler: (stream: TunnelStream) => this.openLan(t, lan, stream) } : {}),
            refusal,
            ca: trustedCas(this.creds?.ca || ''),
            log: this.log,
            onEnd: (c, reason) => {
                if (this.tunnels.get(t.id) === c) {
                    this.tunnels.delete(t.id);
                    this.shells.delete(t.id);
                    this.knxStreams.delete(t.id);
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
                `Remote access to ${ACCESS_LABEL[t.kind]}${target ? ` (${target.instance})` : ''}${knx ? ` (gateway ${gatewayText(knx.gateway)})` : ''}${lan ? ` ${lan.name} (${lan.host}, ports ${lan.ports.join(', ')})` : ''} ${resumed ? 'resumed' : 'opened'} by ${t.by} until ${new Date(t.expiresAt).toLocaleTimeString()}: ${t.purpose}`,
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
        if (t.kind === 'knx') {
            return this.knxStreams.get(t.id) ? ' (ETS verbunden)' : '';
        }
        if (t.kind === 'lan') {
            const n = this.knxStreams.get(t.id) ?? 0;
            return `${t.lan ? ` ${t.lan.name}` : ''}${n ? ` (${n} ${n === 1 ? 'Verbindung' : 'Verbindungen'})` : ''}`;
        }
        if (t.kind !== 'console') {
            return '';
        }
        const n = this.shells.get(t.id) ?? 0;
        return n ? ` (${n} ${n === 1 ? 'Shell' : 'Shells'} offen)` : '';
    }

    /** Shows the owner who is connected right now, and why: remote access and AI access */
    private async updateAccessStates(): Promise<void> {
        const active = [...this.tunnels.values()].map(c => c.req);
        const ai = this.ai?.list() ?? [];
        const until = (ts: number): string =>
            new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        await this.setState('info.remoteAccess', active.length + ai.length > 0, true);
        await this.setState(
            'info.remoteAccessBy',
            [
                ...active.map(
                    t =>
                        `${ACCESS_LABEL[t.kind]}${t.instance ? ` (${t.instance})` : ''}${this.shellText(t)}: ${t.by}, ${t.purpose} (bis ${until(t.expiresAt)})`,
                ),
                ...ai.map(s => `KI: ${s.by}, ${s.purpose} (bis ${until(s.expiresAt)})`),
            ]
                // in the settings an empty value would show the label alone
                .join('; ') || 'keiner',
            true,
        );
    }

    // ------------------------------------------------------------------ inventory and heartbeat

    /**
     * Reads the active repositories. system.repositories has several megabytes: only on start, when admin loads
     * the repositories again and when another repository is set.
     *
     * @param repositories the changed object system.repositories; undefined: read it
     */
    private async readRepos(repositories?: ioBroker.Object | null): Promise<void> {
        try {
            const config = await this.getForeignObjectAsync('system.config');
            const active: unknown = config?.common?.activeRepo;
            this.activeRepoKey = JSON.stringify(active ?? null);
            const repos =
                repositories === undefined ? await this.getForeignObjectAsync('system.repositories') : repositories;
            this.repos = repoCatalog(active, repos?.native?.repositories);
        } catch (e) {
            this.log.debug(`Repositories not readable: ${(e as Error).message}`);
            this.repos = undefined;
        }
    }

    private async onObjectChange(id: string, obj: ioBroker.Object | null | undefined): Promise<void> {
        if (id === 'system.config') {
            const active: unknown = (obj?.common as { activeRepo?: unknown } | undefined)?.activeRepo;
            if (JSON.stringify(active ?? null) === this.activeRepoKey) {
                return;
            }
            await this.readRepos();
        } else if (id === 'system.repositories') {
            await this.readRepos(obj ?? null);
        } else {
            return;
        }
        await this.sendInventory(false);
    }

    private async inventory(withHosts = true): Promise<Inventory> {
        const inv = await collectInventory(this, {
            agentVersion: this.version || '',
            dataDir: this.dataDir,
            lastBackup: this.persisted.lastBackup,
            nodeModules: join(utils.controllerDir, '..'),
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
        // the remote access opens a project of vis-2 directly
        if (inv.accessTargets.vis?.length) {
            inv.visProjects = await visProjects(this);
        }
        if (inv.remoteAccess.includes('console')) {
            inv.consoleUser = consoleUser();
        }
        if (this.monitor) {
            inv.monitors = this.monitor.status();
        }
        if (inv.remoteAccess.includes('knx')) {
            const gateway = await this.knxGateway();
            inv.knx = { gateway: gateway ? gatewayText(gateway) : null, transport: this.config.knxTransport || 'auto' };
        }
        if (inv.remoteAccess.includes('lan') || inv.remoteAccess.includes('knx')) {
            inv.lan = lanInfo(this.config);
        }
        inv.commands = [...supportedCommands(inv.software.jsController), 'hosts', 'repoUpdate', 'visProjects'];
        if (withHosts) {
            try {
                inv.hosts = await this.collectOtherHosts();
            } catch (e) {
                this.log.warn(`Other hosts of the system not readable: ${e.message}`);
                inv.hosts = [...this.knownHosts.values()];
            }
        }
        const ai = aiAccess(this.config, process.versions.node);
        if (ai) {
            inv.ai = ai;
        }
        const names = new Set([
            ...Object.keys(inv.software.adapters),
            ...(inv.hosts ?? []).flatMap(h => Object.keys(h.adapters ?? {})),
        ]);
        const repo = repoInfo(this.repos, [...names]);
        if (repo) {
            inv.repo = repo;
        }
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

    /** The other hosts of the system, see collectHosts */
    private async collectOtherHosts(): Promise<HostInventory[]> {
        const instances = async (): Promise<ioBroker.InstanceObject[]> =>
            (
                await this.getObjectViewAsync('system', 'instance', {
                    startkey: 'system.adapter.',
                    endkey: 'system.adapter.香',
                })
            ).rows
                .map(r => r.value as ioBroker.InstanceObject | undefined)
                .filter((o): o is ioBroker.InstanceObject => !!o);
        return collectHosts(
            {
                own: this.host || '',
                hostObjects: async () =>
                    (
                        await this.getObjectViewAsync('system', 'host', {
                            startkey: 'system.host.',
                            endkey: 'system.host.香',
                        })
                    ).rows
                        .map(r => r.value)
                        .filter((o): o is ioBroker.HostObject => !!o),
                alive: host => this.hostAlive(host),
                send: (host, command, message, timeoutMs) => this.sendHost(host, command, message, timeoutMs),
                instances,
                describe: obj =>
                    describeInstance(
                        obj,
                        id => this.getForeignStateAsync(id),
                        () => this.webInstances(),
                    ),
                installedFrom: async () => {
                    const rows = await this.getObjectViewAsync('system', 'adapter', {
                        startkey: 'system.adapter.',
                        endkey: 'system.adapter.香',
                    });
                    return Object.fromEntries(
                        rows.rows
                            .filter(r => r.value?.common?.name)
                            .map(r => [r.value.common.name, r.value.common.installedFrom]),
                    );
                },
                osUpdates: async host =>
                    osUpdatesFrom(await this.getForeignStateAsync(`system.host.${host}.osPackageUpdates`), false),
            },
            this.knownHosts,
        );
    }

    /** Watches the states of the rules in the table "Überwachung" */
    private async startMonitor(): Promise<void> {
        const rules = validRules(this.config.monitors);
        if (!rules.length) {
            return;
        }
        const monitor = new Monitor(rules);
        for (const id of monitor.stateIds()) {
            try {
                monitor.setUnit(id, (await this.getForeignObjectAsync(id))?.common?.unit);
                monitor.update(id, await this.getForeignStateAsync(id));
                await this.subscribeForeignStatesAsync(id);
            } catch (e) {
                this.log.warn(`Monitoring: ${id} not readable: ${e.message}`);
            }
        }
        this.monitor = monitor;
        this.log.info(
            `Monitoring ${rules.length} ${rules.length === 1 ? 'rule' : 'rules'} on ${monitor.stateIds().length} states`,
        );
        // the delays and "no update for n minutes" run out without any new value
        this.timers.push(setInterval(() => this.checkMonitor(), 10_000));
        this.checkMonitor();
    }

    /** An alert that starts or stops goes to the fleet management right away, not with the next inventory */
    private checkMonitor(): void {
        const changed = this.monitor?.evaluate() ?? [];
        for (const m of changed) {
            const text = `Monitoring: ${monitorText(m)}`;
            if (m.alert || m.missing) {
                this.log.warn(text);
            } else {
                this.log.info(text);
            }
        }
        if (changed.length && !this.monitorSendTimer) {
            // several rules on one state flip together: one inventory for all
            this.monitorSendTimer = setTimeout(() => {
                this.monitorSendTimer = null;
                void this.sendInventory(false);
            }, 2_000);
            this.timers.push(this.monitorSendTimer);
        }
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
            await this.keepOwnBackup(backupPath(backup.detail), backup.ts || Date.now());
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

    /**
     * Notes a backup made before a job and deletes the own ones beyond OWN_BACKUPS_KEEP: without that, every update
     * left another archive on the card. BackItUp and backups made by hand stay untouched.
     */
    private async keepOwnBackup(file: string, ts: number): Promise<void> {
        let size = 0;
        try {
            size = (await stat(file)).size;
        } catch {
            // gone already
        }
        // before 0.5.0 only the last one was noted (with its size in the text): it counts as the first own one
        const earlier =
            this.persisted.ownBackups ??
            (this.persisted.lastBackup?.file ? [backupPath(this.persisted.lastBackup.file)] : []);
        const { keep, remove } = pruneOwnBackups(earlier, file);
        for (const old of remove) {
            try {
                await rm(old, { force: true });
                this.log.info(`Deleted own backup ${old} (keeping the last ${OWN_BACKUPS_KEEP})`);
            } catch (e) {
                this.log.warn(`Cannot delete own backup ${old}: ${e.message}`);
            }
        }
        this.persisted.ownBackups = keep;
        this.persisted.lastBackup = { ts, file, size };
    }

    /** Converges on the desired state if possible. Never runs two jobs at once. */
    private async reconcile(): Promise<void> {
        if (this.reconciling || this.unloading || !this.jobs || this.jobs.isActive() || this.adapterWaiting) {
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
        const inv = await this.inventory(false);
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
            ...nodeBlockers(await nodeFacts(recentOffDeviceBackup(inv.backup))),
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
        if (this.monitor?.watches(id)) {
            this.monitor.update(id, state);
            this.checkMonitor();
        }
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
