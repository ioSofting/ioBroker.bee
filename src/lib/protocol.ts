/**
 * Wire protocol between beekeeper (server) and its agents: ioBroker.bee on ioBroker, bee-ha (beekeeper-server/bee-ha)
 * next to Home Assistant, bee-linux on a Linux server.
 *
 * This file exists in three repositories: beekeeper-server/src/protocol.ts, ioBroker.bee/src/lib/protocol.ts and
 * bee-linux/src/lib/protocol.ts. All copies must stay identical. Bump PROTOCOL_VERSION on breaking changes.
 *
 * Topics (one tree per tenant and device, ACL restricts a device to its own tree):
 *   fleet/<tenant>/<device>/state      device -> server  heartbeat, online flag (also Last Will)
 *   fleet/<tenant>/<device>/inventory  device -> server  full inventory or diff to the last one
 *   fleet/<tenant>/<device>/result     device -> server  progress and result of reconciliation
 *   fleet/<tenant>/<device>/reply      device -> server  progress and result of a command (JobMessage.ref)
 *   fleet/<tenant>/<device>/desired    server -> device  desired state, RETAINED
 *   fleet/<tenant>/<device>/job        server -> device  one-shot requests (resync, refresh, tunnel, commands)
 *   fleet/<tenant>/control             server -> device  fleet-wide control (emergency stop), RETAINED
 *
 * Payloads are JSON, gzip-compressed. Receivers accept plain JSON as well.
 *
 * Remote access to admin and vis-2 does not run over MQTT: on a job "tunnel" the agent opens a
 * WebSocket to TUNNEL_PATH of the server and carries the connections of the browser (see tunnel.ts).
 */

export const PROTOCOL_VERSION = 1;

export type Topic = 'state' | 'inventory' | 'result' | 'reply' | 'desired' | 'job';

export function deviceTopic(tenantId: string, deviceId: string, topic: Topic): string {
    return `fleet/${tenantId}/${deviceId}/${topic}`;
}

export function controlTopic(tenantId: string): string {
    return `fleet/${tenantId}/control`;
}

/** Longest comment a device reports (Inventory.comment, EnrollRequest.comment) */
export const MAX_COMMENT_LENGTH = 200;

/**
 * Comment as both sides handle it: one line, no control characters, trimmed and shortened.
 * Empty or not a string: undefined.
 */
export function normalizeComment(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const s = value
        .replace(/\p{Cc}+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_COMMENT_LENGTH)
        .trim();
    return s || undefined;
}

/** Heartbeat. Small, sent periodically and on connect. `online: false` is the Last Will. */
export interface StateMessage {
    v: number;
    ts: number;
    online: boolean;
    agentVersion?: string;
    uptime?: number;
    load?: number;
    memFree?: number;
    diskFree?: number;
    temperature?: number;
    /** Error log lines since the previous heartbeat */
    logErrors?: number;
    /** Sectors written to the SD card since boot, if readable (write load, wear of the card) */
    sdWrites?: number | null;
    /** Local job state, if a job is active */
    jobState?: JobState;
    /** Values of configured signal states, e.g. LTE quality (no measured values of the end customer) */
    signal?: number | null;
}

export interface AdapterInventory {
    version: string;
    installedFrom?: string;
}

export interface InstanceInventory {
    enabled: boolean;
    alive: boolean;
    mode?: string;
    /** Runs as a web extension inside this web instance ("*": every one), without a process of its own */
    webInstance?: string;
    /** Only files for web (common.onlyWWW): js-controller starts no process for it */
    onlyWWW?: boolean;
}

/**
 * The system an agent looks after: ioBroker (ioBroker.bee), Home Assistant (bee-ha) or a Linux server (bee-linux).
 * For Home Assistant and Linux the parts of the inventory about ioBroker (software, hosts, repo, backup by BackItUp)
 * stay empty, and there are no profiles or rollouts.
 */
export type Platform = 'iobroker' | 'homeassistant' | 'linux';

/** A filesystem of a Linux server (LinuxInfo.mounts); percentages rounded, so that the inventory rarely changes */
export interface LinuxMount {
    /** e.g. "/", "/var/lib/docker" */
    path: string;
    /** e.g. "/dev/sda1" */
    device: string;
    /** e.g. "ext4" */
    fstype: string;
    /** Bytes */
    size: number;
    /** Used share of the space, 0-100 */
    usedPct: number;
    /** Used share of the inodes, 0-100; null: the filesystem reports none (btrfs) */
    inodesPct: number | null;
}

/**
 * What the agent checks on a Linux server, set in the portal (command 'checks'):
 * - service: a unit of systemd is active (target: "nginx" or "nginx.service")
 * - tcp: a port answers (target: "host:port")
 * - http: an address answers with status (default 200-399) and optionally a text in the body (target: the URL)
 * - cert: the TLS certificate of "host:port" (SNI host) is valid for at least warnDays more (default 14)
 * - file: a file or the newest file in a folder is at most maxAgeHours old (default 26), e.g. a backup
 * - journal: lines of the journal matching the regular expression `text` in the last windowMinutes (default 60),
 *   of the unit `target` (empty: all); more than maxCount (default 0) is a failure
 */
export type CheckKind = 'service' | 'tcp' | 'http' | 'cert' | 'file' | 'journal';
export const CHECK_KINDS: CheckKind[] = ['service', 'tcp', 'http', 'cert', 'file', 'journal'];

export interface CheckSpec {
    /** Stable id, given by the portal */
    id: string;
    /** Name shown in the portal, e.g. "Webseite Shop" */
    name: string;
    kind: CheckKind;
    target: string;
    /** http: expected status */
    status?: number;
    /** http: text the body must contain; journal: regular expression */
    text?: string;
    /** Seconds for tcp, http and cert (default 10) */
    timeout?: number;
    /** cert: days before the end that count as warning */
    warnDays?: number;
    /** file */
    maxAgeHours?: number;
    /** journal */
    windowMinutes?: number;
    maxCount?: number;
    /** Severity of the deviation when the check fails: 1 mittel, 2 hoch (default), 3 kritisch */
    severity?: 1 | 2 | 3;
}

/** Result of a check; the text has no times or durations, so that the inventory only changes with the result */
export interface CheckResult {
    id: string;
    /** ok, warn (works, but not for long: certificate), fail */
    state: 'ok' | 'warn' | 'fail';
    /** e.g. "active", "HTTP 503", "gültig bis 2026-12-01" */
    text: string;
    /** Since when the check has this state */
    since: number;
}

/** A process of pm2 (LinuxInfo.pm2) */
export interface Pm2Process {
    name: string;
    /** online, stopped, errored, launching ... */
    status: string;
    restarts: number;
}

/** A container of Docker (LinuxInfo.docker) */
export interface DockerContainer {
    name: string;
    image: string;
    /** running, exited, restarting, paused, created, dead */
    state: string;
    /** healthy, unhealthy, starting; missing: no health check */
    health?: string;
    /** Exit code of an exited container */
    exitCode?: number;
}

/**
 * A Linux server as bee-linux sees it (Inventory.linux). Load, memory and the free space of / come with the
 * heartbeat (StateMessage). Not part of the history.
 */
export interface LinuxInfo {
    /** PRETTY_NAME of /etc/os-release, e.g. "Debian GNU/Linux 12 (bookworm)" (also in system.os) */
    distro: string;
    cpus: number;
    swapTotal: number;
    mounts: LinuxMount[];
    /** Units of systemd in state failed */
    failedUnits: string[];
    /** The clock is synchronized (timedatectl); null: unknown */
    ntpSynced: boolean | null;
    /** The checks of the portal the agent runs: the hash it got with them (JobMessage.checks), null: none yet */
    checksHash: string | null;
    checks: CheckResult[];
    /**
     * The journal of the last 24 hours, counted every 10 minutes: lines of priority error and worse per unit (the 10
     * with the most), of the kernel, and failed logins of SSH. null: the agent may not read the journal (group
     * systemd-journal).
     */
    journal: {
        errors: { unit: string; count: number }[];
        kernelErrors: number;
        sshFailed: number;
    } | null;
    /** Processes of pm2 (of BEE_PM2_USER through sudo); null: no pm2 */
    pm2: Pm2Process[] | null;
    /** Containers of Docker; null: no Docker, or the agent may not ask it */
    docker: DockerContainer[] | null;
    /** What sudo allows the agent: apt (update and upgrade of packages), reboot */
    sudo: { apt: boolean; reboot: boolean };
    /**
     * The newest version of bee-linux on npm, looked up by the agent every few hours when it may update itself
     * (command agentUpdate; since 0.3.0). null: not known.
     */
    agentLatest?: string | null;
}

/** Home Assistant as bee-ha sees it next to it (Inventory.homeassistant) */
export interface HomeAssistantInfo {
    /** e.g. "2026.11.1"; null: not known (the configuration folder is not readable for the agent) */
    version: string | null;
    /** How it is installed, as far as the agent knows: container, os (Home Assistant OS), supervised, core */
    installation: string;
    /** Name of the home (core.config), if readable */
    locationName?: string;
    /** Home Assistant answers on its address (the last check of the agent) */
    reachable: boolean;
}

/** Slowly changing inventory. Volatile metrics belong into StateMessage, they would flood the history. */
export interface Inventory {
    /** Missing: ioBroker (every ioBroker.bee) */
    platform?: Platform;
    /** Only with platform 'homeassistant' */
    homeassistant?: HomeAssistantInfo;
    /** Only with platform 'linux' */
    linux?: LinuxInfo;
    agentVersion: string;
    uuid: string;
    hostname: string;
    /**
     * Free text from the instance configuration of the agent, e.g. "Womo Mercedes KA-1525".
     * Helps people recognize the installation; reported by the device itself, so it is no proof
     * of identity (that is the client certificate). Not part of the history.
     */
    comment?: string;
    /**
     * Web interfaces the owner allows to reach through the tunnel (instance configuration of the agent).
     * Missing: the agent cannot open a tunnel at all. Not part of the history.
     */
    remoteAccess?: AccessKind[];
    /**
     * Enabled instances per kind on the host of the agent (admin; web for vis-2, only with vis-2 installed),
     * to choose from when opening a remote access; for kind web the web interfaces of devices in the network the
     * owner lists in the instance of bee, by name (since agent 0.6.0). An empty list: nothing to offer. Missing:
     * older agent, it takes the first instance. Not part of the history.
     */
    accessTargets?: Partial<Record<AccessKind, AccessInstance[]>>;
    /**
     * Projects of vis-2: folders in the file storage of vis-2.0 with a vis-views.json, sorted (since agent 0.3.2).
     * The remote access opens one of them directly, in the runtime or the editor. Missing: unknown.
     */
    visProjects?: string[];
    /** User the shell of the console runs as; only reported while the console is allowed */
    consoleUser?: string;
    /**
     * KNX for ETS (remote access of kind knx): the gateway in the LAN of the device, set in the instance of bee
     * or taken from the adapter knx/openknx (since agent 0.4.0). Only while the owner allows KNX; gateway null:
     * allowed, but no gateway known.
     */
    knx?: KnxInfo;
    /**
     * Devices in the network (remote access of kind lan, and KNX gateways named by the server): the boundary the
     * owner sets in the instance of bee (since agent 0.5.0). Only while the owner allows devices in the network or
     * KNX; missing: neither, or an older agent.
     */
    lan?: LanInfo;
    /**
     * Monitoring: rules on states set in the instance of bee, e.g. "victron.0.voltage < 11.5, warning", and how they
     * stand (since agent 0.5.0). A rule that alerts is a deviation of the asset. Missing: no rules or older agent.
     * Not part of the history.
     */
    monitors?: MonitorStatus[];
    /**
     * Updates of operating system packages as js-controller (6 and newer) lists them, see OsUpdates.
     * Missing: unknown (older agent, older js-controller, no Linux). Not part of the history.
     */
    osUpdates?: OsUpdates;
    /**
     * The adapter repositories set in admin and the versions of the installed adapters there, see RepoInfo.
     * Missing: unknown (older agent, no repository active). Not part of the history.
     */
    repo?: RepoInfo;
    /**
     * The owner allows the AI access (instance setting of the agent, off by default), see AiAccess.
     * Missing: not allowed, or an older agent. Not part of the history.
     */
    ai?: AiAccess;
    /** Commands this agent understands (JobMessage.cmd); missing: none */
    commands?: AgentCommand[];
    /**
     * The other hosts of this ioBroker system (multihost), see HostInventory; the agent runs on the host of
     * `hostname` and maintains these through js-controller (command 'hosts'). Empty: a single host. Missing: older
     * agent (before 0.3.0), which also listed the adapters of other hosts as its own.
     */
    hosts?: HostInventory[];
    /**
     * Adapters and instances of the host of the agent only: an adapter whose package is not on this host (installed
     * on another host of the system) is in HostInventory.adapters of that host.
     */
    software: {
        jsController: string;
        node: string;
        npm: string;
        adapters: Record<string, AdapterInventory>;
        instances: Record<string, InstanceInventory>;
    };
    system: {
        platform: string;
        arch: string;
        os: string;
        kernel: string;
        model: string;
        memTotal: number;
        diskTotal: number;
    };
    backup: {
        /** Last local backup created by the agent */
        lastLocal?: { ts: number; file: string; size: number } | null;
        /** Is an off-device backup target configured (backitup)? */
        offDevice: boolean;
        /**
         * BackItUp of the system (since 0.3.0 on any host, before only the host of the agent), see BackitupInfo.
         * null: no instance of BackItUp. Missing:
         * older agent (before 0.2.11). Only the settings are part of the history, not the runs.
         */
        backitup?: BackitupInfo | null;
        /**
         * The automatic backup of Home Assistant (bee-ha), see HaBackupInfo. null: never set up. Missing: not a Home
         * Assistant, or the configuration folder is not mounted for the agent.
         */
        homeassistant?: HaBackupInfo | null;
    };
}

/**
 * Another host of the ioBroker system (multihost, since agent 0.3.0), as its js-controller reports it to the agent:
 * the agent maintains it with host commands (sendToHost), without an instance of its own there. Node.js, desired
 * profiles, the console and remote access to admin are for the host of the agent only.
 */
export interface HostInventory {
    /** Name of the host in ioBroker (system.host.<name>) */
    name: string;
    /** js-controller of the host runs (system.host.<name>.alive) */
    alive: boolean;
    jsController: string;
    /** Missing: not known yet (the host did not answer since the agent started) */
    node?: string;
    npm?: string;
    system?: {
        platform: string;
        arch: string;
        /** As far as js-controller tells it, e.g. "linux" or "docker" */
        os: string;
        kernel: string;
        model: string;
        memTotal: number;
        diskTotal: number;
    };
    /**
     * Adapters whose package is on this host (host command getInstalled), without js-controller. Missing: the host did
     * not answer since the agent started.
     */
    adapters?: Record<string, AdapterInventory>;
    /** Instances of this host */
    instances: Record<string, InstanceInventory>;
    /** As Inventory.osUpdates; rebootRequired is always false: not readable from another host */
    osUpdates?: OsUpdates;
    /** Commands of the agent that work on this host (JobMessage.host) */
    commands: AgentCommand[];
}

/**
 * The automatic backup of Home Assistant, as set in Settings, System, Backups: bee-ha reads it from the storage file
 * .storage/backup in the configuration folder (Home Assistant 2025.1 and newer), without a token.
 */
export interface HaBackupInfo {
    /** Automatic backups are set up and not on "never" */
    scheduled: boolean;
    /** Longest gap between two automatic backups in days (daily: 1; custom days, e.g. Monday and Thursday: 4) */
    everyDays: number;
    /** Locations outside the device (backup agents other than backup.local and hassio.local), e.g. "cloud.cloud" */
    targets: string[];
    /** The last automatic backup started (ms) */
    lastAttempt: number | null;
    /** The last automatic backup finished (ms); with a target outside the device, it went there too */
    lastOk: number | null;
    /** Size of the last finished one (bytes) */
    lastSize: number | null;
}

/**
 * The backup of ioBroker by BackItUp (since agent 0.2.11): what is set up and how the last runs went, from the
 * settings of the instance and its states history.*. The fleet management judges from it whether the installation is
 * backed up; the agent requires a recent backup outside the device for the update of Node.js.
 */
export interface BackitupInfo {
    /** Instance, e.g. "backitup.0" */
    instance: string;
    /** The instance is enabled */
    enabled: boolean;
    /** The automatic backup of ioBroker is switched on */
    scheduled: boolean;
    /** Days between two automatic backups: 1 = daily; with an own cron schedule estimated from it */
    everyDays: number;
    /** Targets outside the device that are switched on: ftp, cifs, nfs, dropbox, webdav, googledrive, onedrive */
    targets: string[];
    /** The last backup of ioBroker: its end, whether it worked and if not why (shortened); null: none yet */
    lastRun: { ts: number; ok: boolean; error?: string } | null;
    /** The newest backup of ioBroker without error in the history of BackItUp (start of the run, bytes) */
    lastOk: { ts: number; size: number | null } | null;
    /** Start of the newest backup of ioBroker without error that went to a target outside the device */
    lastOffDevice: number | null;
}

/**
 * Days a backup may be old before it is overdue: the interval of the schedule and one day for the run
 *
 * @param b the settings of BackItUp
 */
export function backupMaxAgeDays(b: Pick<BackitupInfo, 'everyDays'>): number {
    return Math.max(1, b.everyDays || 1) + 1;
}

/**
 * AI access (command 'mcp', since agent 0.2.9): an AI of the integrator works with the MCP server of ioBroker
 * (package `@iobroker/mcp-server`), which the agent runs in its own process. Only while a person opened an AI session
 * in the fleet management, and only with the rights the owner gives here.
 */
export interface AiAccess {
    /** ioBroker user the tools run as, e.g. "admin" */
    user: string;
    /** Writing states (set_state) is allowed; otherwise reading only */
    setState: boolean;
    /** Changing objects, files and scripts is allowed */
    objectChange: boolean;
    /** Managing users is allowed (Home Assistant: the switch "Benutzer verwalten" of the integration Beekeeper) */
    users?: boolean;
    /** Why the MCP server cannot run on this device, e.g. Node.js too old; missing: it can */
    error?: string;
}

/** A tool of the MCP server on the device, as MCP lists it */
export interface McpTool {
    name: string;
    title?: string;
    description?: string;
    /** JSON Schema of the arguments */
    inputSchema: Record<string, unknown>;
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
}

/**
 * A request of the AI to the device. Every request carries the session, so the agent knows it after its own restart
 * as well; it refuses requests after expiresAt.
 * open: check that the MCP server runs and show the session on the device; tools: list the tools; call: call one;
 * close: the session ended (the agent forgets it)
 */
export interface McpRequest {
    session: string;
    action: 'open' | 'tools' | 'call' | 'close';
    expiresAt: number;
    /** Who opened the session and why; shown on the device */
    by: string;
    purpose: string;
    /** For call */
    tool?: string;
    args?: Record<string, unknown>;
}

/** Answer of the agent to an McpRequest (ReplyMessage.mcp); errors of the request itself come as state 'error' */
export interface McpReply {
    /** For open and tools */
    tools?: McpTool[];
    /** For call: the text of the tool, isError if the tool failed */
    result?: { text: string; isError: boolean; truncated?: boolean };
}

/** Longest text of a tool result the agent sends back (characters); longer ones are cut and marked truncated */
export const MAX_MCP_RESULT = 512 * 1024;

/**
 * Tools of Home Assistant (integration Beekeeper) that only the portal calls, not the AI directly: create_user gets
 * a password the portal makes and keeps in the access data of the asset (src/mcp.ts device_create_ha_login)
 */
export const HA_PORTAL_TOOLS = ['create_user'];

/**
 * Tools of Home Assistant that install something, as device_update_adapter for ioBroker: the AI gets them only with
 * the permission assign and where an admin allowed updates by the AI for the asset (aiPolicy.update)
 */
export const HA_UPDATE_TOOLS = ['install_update'];

/** A package of the operating system that can be upgraded, from a line of `apt list --upgradeable` */
export interface OsPackage {
    name: string;
    /** Version after the upgrade */
    version?: string;
    /** Installed version */
    from?: string;
    /** From a security suite, e.g. "bookworm-security", "noble-security" */
    security?: boolean;
}

/**
 * The adapter repositories active in admin (system.config common.activeRepo), as js-controller keeps them in
 * system.repositories. Admin loads them daily and shows from them which adapters have an update.
 */
export interface RepoInfo {
    /**
     * Active repositories in their order, e.g. beta with http://download.iobroker.net/sources-dist-latest.json;
     * the link without user, password and query. time: when js-controller loaded it, null: not loaded yet.
     */
    active: { name: string; link: string; time: number | null }[];
    /**
     * Version of each installed adapter and of js-controller in the active repositories, merged as js-controller
     * does it (a later repository wins). Missing: not in a repository, or no repository loaded yet.
     */
    versions: Record<string, string>;
}

export interface OsUpdates {
    packages: OsPackage[];
    /** When js-controller last listed them (it does on every update of the repository, admin does that daily) */
    checkedAt: number | null;
    /** The system asks for a reboot (/var/run/reboot-required) */
    rebootRequired: boolean;
}

/**
 * Parses a line of `apt list --upgradeable`, e.g.
 * "openssl/stable-security 3.0.15-1~deb12u1 arm64 [upgradable from: 3.0.14-1~deb12u2]"
 */
export function parseOsPackage(line: string): OsPackage | null {
    const m = /^([a-z0-9][a-z0-9+.-]*)\/(\S*)\s+(\S+)(?:.*\[[^\]:]*:\s*([^\]\s]+)\])?/i.exec(line.trim());
    if (!m) {
        return null;
    }
    return {
        name: m[1],
        version: m[3],
        ...(m[4] ? { from: m[4] } : {}),
        ...(/(^|[,-])security(,|$)/.test(m[2]) ? { security: true } : {}),
    };
}

/** Instance id as the commands accept it, e.g. "javascript.0" */
export const INSTANCE_ID = /^[a-z0-9][a-z0-9_-]*\.\d{1,4}$/;

export type InstanceAction = 'start' | 'stop' | 'restart';

/**
 * Commands from the asset detail an agent may understand (Inventory.commands). hosts: the agent reports the other
 * hosts of the system (Inventory.hosts) and carries out commands there (JobMessage.host). controller: js-controller
 * can upgrade itself (ioBroker.bee from 0.5.0, Linux, js-controller 5 or newer).
 */
export type AgentCommand =
    | 'instance'
    | 'restart'
    | 'osUpgrade'
    | 'logs'
    | 'adapter'
    | 'software'
    | 'mcp'
    | 'hosts'
    | 'repoUpdate'
    | 'visProjects'
    | 'checks'
    | 'reboot'
    | 'agentUpdate'
    | 'diagnose'
    | 'unit'
    | 'controller';

/**
 * Command 'software' (since agent 0.2.7): removeAdapter removes an adapter with all its instances (not the agent,
 * not js-controller), addInstance creates one more instance of an installed adapter on the host of the agent,
 * removeInstance deletes one instance there
 */
export type SoftwareAction = 'removeAdapter' | 'addInstance' | 'removeInstance';
export const SOFTWARE_ACTIONS: SoftwareAction[] = ['removeAdapter', 'addInstance', 'removeInstance'];

/** A log file of ioBroker on the device, in the directory of a file transport of iobroker.json */
export interface LogFile {
    /** File name, e.g. "iobroker.2026-11-10.log" or "iobroker.2026-11-03.log.gz" */
    name: string;
    size: number;
    mtime: number;
}

/** Largest log file the agent uploads, compressed (nginx in front of the server allows 52 MB) */
export const MAX_LOG_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface InventoryMessage {
    v: number;
    ts: number;
    /** Monotonic counter per device */
    seq: number;
    type: 'full' | 'diff';
    /** For type 'diff': seq the diff is based on */
    baseSeq?: number;
    /** For type 'full' */
    data?: Inventory;
    /** For type 'diff': flattened paths (JSON pointer) to set */
    set?: Record<string, unknown>;
    /** For type 'diff': flattened paths to remove */
    unset?: string[];
}

export interface ProfileAdapter {
    version: string;
    /** From io-package.json of this version, e.g. [{"js-controller": ">=6.0.0"}] */
    dependencies?: Record<string, string>[];
    globalDependencies?: Record<string, string>[];
    /** engines.node of this version */
    node?: string;
    /**
     * Install from this package of the fleet server instead of npm (uploaded tgz, set per asset).
     * The agent downloads it only from its own server and checks the SHA-256 before installing.
     */
    tarball?: { url: string; sha256: string; size: number };
}

export interface DesiredProfile {
    id: string;
    name: string;
    hash: string;
    jsController: string;
    /** Node.js major line, e.g. "22" */
    node: string;
    adapters: Record<string, ProfileAdapter>;
}

export interface DesiredMessage {
    v: number;
    ts: number;
    assetId: string;
    /**
     * managed: follows the profile; self: no automatic rollouts, only hints; free (server from November
     * 2026): without profile, always with profile null (an older agent handles it like no profile)
     */
    mode: 'managed' | 'self' | 'free';
    profile: DesiredProfile | null;
    /** Adapters installed by the owner that are accepted as exceptions */
    tolerated: string[];
    /** Adapters to remove on return to managed mode */
    remove: string[];
    /** Incremented by the server to retry a blocked job for the same profile */
    retry: number;
    rollout?: { id: string; ring: number } | null;
}

export interface ControlMessage {
    v: number;
    ts: number;
    halt: boolean;
    reason?: string;
}

export interface JobMessage {
    v: number;
    ts: number;
    /**
     * instance: start, stop or restart an instance on the host of the agent
     * restart: restart ioBroker (js-controller with all instances)
     * osUpgrade: upgrade packages of the operating system that js-controller listed (OsUpdates)
     * logList: list the log files of ioBroker (answer: ReplyMessage.files)
     * logFetch: upload one of them (command 'logs' of Inventory.commands for both)
     * adapter: install a version of an adapter right away, for an asset without desired profile (since 0.2.6)
     * software: remove an adapter, add or delete an instance right away (since 0.2.7)
     * mcp: a request of the AI access to the MCP server on the device (since 0.2.9)
     * repoUpdate: load the active adapter repositories again, as admin does with "update adapter list"; they are the
     * same for every host of the system (since 0.3.1)
     * visProjects: list the projects of vis-2 right now, as Inventory.visProjects (answer: ReplyMessage.projects; since
     * 0.3.2); only reads, also during a job
     * checks: the checks of the portal for a Linux server (bee-linux), replacing the ones before; no answer, the agent
     * reports LinuxInfo.checksHash
     * reboot: restart the operating system (bee-linux)
     * agentUpdate: install the newest version of the agent itself (bee-linux from 0.4.0: from npm, never from the
     * server); the agent answers when the installation started, then it restarts
     * diagnose: details for a deviation, for a person who clicks on it (bee-linux from 0.5.0; answer: ReplyMessage.text);
     * only reads, with fixed arguments per code
     * unit: restart a failed unit of systemd, or clear its failed state (bee-linux from 0.5.0, SERVICES=1)
     * controller: upgrade js-controller, as admin does it: js-controller starts its upgrade manager, which stops
     * ioBroker, installs the version with npm and starts ioBroker again (ioBroker.bee from 0.5.0). The agent answers
     * "running" once js-controller took the order; the outcome is the version in the next inventory of that host.
     */
    cmd:
        | 'resync'
        | 'refresh'
        | 'tunnel'
        | 'instance'
        | 'restart'
        | 'osUpgrade'
        | 'logList'
        | 'logFetch'
        | 'adapter'
        | 'software'
        | 'mcp'
        | 'repoUpdate'
        | 'visProjects'
        | 'checks'
        | 'reboot'
        | 'agentUpdate'
        | 'diagnose'
        | 'unit'
        | 'controller';
    /** For cmd 'diagnose': the code of the deviation and what it is about */
    diagnose?: { code: string; subject?: string };
    /** For cmd 'unit' */
    unit?: { name: string; action: 'restart' | 'reset-failed' };
    /** For cmd 'controller': the version of js-controller to install, newer than the installed one */
    controller?: { version: string };
    /** For cmd 'tunnel' */
    tunnel?: TunnelRequest;
    /** Commands: the agent answers on topic reply with this reference */
    ref?: string;
    /** Who asked, for the log on the device */
    by?: string;
    /**
     * For instance, restart, osUpgrade, logList, logFetch, adapter, software and controller: on this other host of the system
     * (HostInventory.name, one of its HostInventory.commands); missing: on the host of the agent. Only to an agent
     * with the command 'hosts': an older one would do it on its own host.
     */
    host?: string;
    /** For cmd 'instance' */
    instance?: { id: string; action: InstanceAction };
    /**
     * For cmd 'osUpgrade': names out of OsUpdates.packages (the agent takes no others); restart: restart ioBroker
     * after it; reboot: restart the operating system after it (bee-linux)
     */
    osUpgrade?: { packages: string[]; restart: boolean; reboot?: boolean };
    /** For cmd 'checks': all checks and a hash of them, which the agent reports back (LinuxInfo.checksHash) */
    checks?: { hash: string; list: CheckSpec[] };
    /**
     * For cmd 'logFetch': upload the file (a name out of the list) compressed with gzip, "POST url" with the
     * header "Authorization: Bearer <ticket>". The url must belong to the own server; the ticket is good once.
     */
    logFetch?: { file: string; url: string; ticket: string };
    /**
     * For cmd 'adapter': install this version (upgrade, downgrade, or a new adapter with one instance), from
     * npm or from a package of the own server (same rules as ProfileAdapter.tarball). Not js-controller, and
     * not while the asset follows a desired profile in managed mode: that would turn it back.
     */
    adapter?: { name: string; version: string; tarball?: { url: string; sha256: string; size: number } };
    /**
     * For cmd 'software': instance is the id for removeInstance (e.g. "javascript.1"). removeAdapter not for an
     * adapter of the desired profile in managed mode: the server removes it with a job (DesiredMessage.remove).
     */
    software?: { action: SoftwareAction; adapter: string; instance?: string };
    /** For cmd 'mcp' */
    mcp?: McpRequest;
}

/** Answer to a command: 'running' first if it takes a while, then 'done' or 'error' */
export interface ReplyMessage {
    v: number;
    ts: number;
    ref: string;
    state: 'running' | 'done' | 'error';
    message?: string;
    /** For cmd 'logList': the log files, newest first */
    files?: LogFile[];
    /** For cmd 'visProjects': the projects of vis-2, sorted */
    projects?: string[];
    /** For cmd 'diagnose': the details, plain text */
    text?: string;
    /** For cmd 'mcp' */
    mcp?: McpReply;
}

/**
 * Kinds of remote access through the tunnel: the web interfaces admin, and web with vis-2, a shell on the
 * device (console; off unless the owner switches it on, see tunnel.ts for its messages), and KNX for ETS
 * (knx; off unless the owner switches it on). A stream of knx carries KNXnet/IP frames back to back as over
 * TCP (HPAIs "TCP, 0.0.0.0:0"); the agent passes them to its gateway, over UDP if the gateway has no TCP.
 * ha: the web interface of Home Assistant (agent bee-ha only). lan: a device in the network of the asset, e.g. a
 * LOGO! or an S7 (off unless the owner switches it on): every stream is one TCP connection to TunnelRequest.lan,
 * its OPEN frame names the port (portMeta in tunnel.ts). web: the web interface of a device in the network, e.g. a
 * router, an inverter or a camera, in the browser as admin: the owner lists name and address in the instance of bee
 * (Inventory.accessTargets.web), the server names the device (TunnelRequest.instance), the agent connects to the
 * address of its own list and nowhere else (since agent 0.6.0).
 */
export type AccessKind = 'admin' | 'vis' | 'console' | 'knx' | 'ha' | 'lan' | 'web';
export const ACCESS_KINDS: AccessKind[] = ['admin', 'vis', 'console', 'knx', 'ha', 'lan', 'web'];

/** Web interfaces of devices in the network one agent offers (kind web) */
export const MAX_WEB_DEVICES = 32;

/**
 * What the owner lets the fleet reach in the network of the device (Inventory.lan). The agent checks every request
 * against it; the portal only shows it.
 */
export interface LanInfo {
    /** Devices in the network may be reached (switch in the instance) */
    devices: boolean;
    /** Networks the devices and KNX gateways named by the server must be in, e.g. "192.168.0.0/24"; only private ones */
    networks: string[];
    /** Ports the devices may be reached on; null: any */
    ports: number[] | null;
}

/** A device in the network for a remote access of kind lan, from the list of the asset in the portal */
export interface LanTarget {
    name: string;
    /** IPv4 address */
    host: string;
    /** TCP ports, at most MAX_LAN_PORTS */
    ports: number[];
}

/** Ports of one device in the network: LOGO! 8 needs two (102, 10005), an S7 one */
export const MAX_LAN_PORTS = 8;

/** What a rule of the monitoring raises: info = Hinweis, warning = Mittel, error = Hoch, critical = Kritisch */
export type MonitorSeverity = 'info' | 'warning' | 'error' | 'critical';
export const MONITOR_SEVERITIES: MonitorSeverity[] = ['info', 'warning', 'error', 'critical'];

/** When a rule alerts: the value compared with its limit, or stale: no update of the state for `value` minutes */
export type MonitorOp = '<' | '<=' | '>' | '>=' | '==' | '!=' | 'stale';
export const MONITOR_OPS: MonitorOp[] = ['<', '<=', '>', '>=', '==', '!=', 'stale'];

/** A rule of the monitoring and how it stands right now (Inventory.monitors) */
export interface MonitorStatus {
    /** The same as long as state, condition and limit stay: "victron.0.voltage < 11.5" */
    id: string;
    label?: string;
    stateId: string;
    op: MonitorOp;
    /** The limit as set ("11.5"); with stale the minutes */
    value: string;
    severity: MonitorSeverity;
    /** common.unit of the state, e.g. "V" */
    unit?: string;
    /** The condition holds, longer than the delay of the rule: a deviation of the asset */
    alert: boolean;
    /** Since when the condition holds (ms), with alert */
    since?: number;
    /** The value: when the alert began, otherwise the last one seen */
    val?: string | number | boolean | null;
    /** Last update of the state (ms) */
    ts?: number;
    /** The state does not exist or has no value */
    missing?: boolean;
}

export interface KnxInfo {
    /** "192.168.1.20" or "host:port" */
    gateway: string | null;
    /** As set by the owner; auto: TCP if the gateway answers on it, otherwise UDP */
    transport: 'auto' | 'tcp' | 'udp';
}

/** A local web interface the agent can carry a remote access to (Inventory.accessTargets) */
export interface AccessInstance {
    /** e.g. "admin.1", "web.0"; kind web: the name of the device as the owner entered it, e.g. "Router" */
    instance: string;
    port: number;
    /** HTTPS (instance setting "secure"; kind web: https:// or port 443 in the address) */
    secure: boolean;
    /** Login required (instance setting "auth"); kind web: false, the device asks for its own login */
    auth: boolean;
    /** Without login every request runs as this user (instance setting "defaultUser") */
    defaultUser?: string;
    /**
     * Kind web: where the device is in the network of the asset, as the owner entered it (IPv4 address or host
     * name, without port), e.g. "192.168.0.1". The portal shows it, and sends it to the device as Host header.
     */
    address?: string;
}

/** WebSocket path of the tunnel endpoint on the server */
export const TUNNEL_PATH = '/tunnel';

/**
 * Request to open a tunnel for one access session. The agent connects to `url` with the header
 * "Authorization: Bearer <ticket>" and carries the connections to the local web interface of `kind`.
 * After a connection loss it reconnects until `expiresAt`; a regular close by the server ends the session.
 */
export interface TunnelRequest {
    /** Access session */
    id: string;
    kind: AccessKind;
    /** wss://<server>/tunnel */
    url: string;
    ticket: string;
    expiresAt: number;
    /** Who opens the access and why; shown on the device */
    by: string;
    purpose: string;
    /**
     * Instance to connect to, one of Inventory.accessTargets of this kind; missing: the first one. Kind web: the
     * name of the device, required (the agent looks up its address in its own list)
     */
    instance?: string;
    /** Kind lan: the device in the network (the agent checks it against Inventory.lan) */
    lan?: LanTarget;
    /**
     * Kind knx: a gateway from the list of the asset instead of the one set in the instance, "192.168.0.10" or
     * "host:port" (since agent 0.5.0; the agent checks it against Inventory.lan). Missing: the one of the instance.
     */
    knxGateway?: string;
}

export type JobState =
    'assigned' | 'waiting' | 'preflight' | 'blocked' | 'backup' | 'rollout' | 'verify' | 'done' | 'rollback';

export const TERMINAL_JOB_STATES: JobState[] = ['done', 'blocked'];

/**
 * A step of a job. node: Node.js to the major line of the profile (from: process.version, to: the major,
 * e.g. "22"); it comes right after the backup and stays when a later step fails. addInstance and
 * removeInstance only for the command 'software', with the instance (e.g. "javascript.1").
 */
export interface JobStep {
    action: 'backup' | 'node' | 'install' | 'upgrade' | 'downgrade' | 'remove' | 'addInstance' | 'removeInstance';
    adapter?: string;
    instance?: string;
    from?: string | null;
    to?: string | null;
    status: 'pending' | 'running' | 'ok' | 'error' | 'skipped';
    ts?: number;
    detail?: string;
}

export interface ResultMessage {
    v: number;
    ts: number;
    profileId: string;
    profileHash: string;
    retry: number;
    state: JobState;
    detail?: string;
    steps?: JobStep[];
}

export interface EnrollRequest {
    token: string;
    uuid: string;
    hostname?: string;
    agentVersion?: string;
    /** See Inventory.comment: shown right after enrollment, before the first inventory */
    comment?: string;
}

export interface EnrollResponse {
    deviceId: string;
    tenantId: string;
    assetId: string;
    mqttUrl: string;
    /** PEM: device certificate, private key and platform CA */
    cert: string;
    key: string;
    ca: string;
}

export interface EnrollError {
    error: 'rejected' | 'rate-limited' | 'invalid';
    reason: string;
}
