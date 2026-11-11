/**
 * Wire protocol between beekeeper (server) and ioBroker.bee (agent).
 *
 * This file exists in both repositories: beekeeper-server/src/protocol.ts and ioBroker.bee/src/lib/protocol.ts.
 * Both copies must stay identical. Bump PROTOCOL_VERSION on breaking changes.
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

/** Slowly changing inventory. Volatile metrics belong into StateMessage, they would flood the history. */
export interface Inventory {
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
     * to choose from when opening a remote access. An empty list: nothing to offer. Missing: older agent,
     * it takes the first instance. Not part of the history.
     */
    accessTargets?: Partial<Record<AccessKind, AccessInstance[]>>;
    /** User the shell of the console runs as; only reported while the console is allowed */
    consoleUser?: string;
    /**
     * Updates of operating system packages as js-controller (6 and newer) lists them, see OsUpdates.
     * Missing: unknown (older agent, older js-controller, no Linux). Not part of the history.
     */
    osUpdates?: OsUpdates;
    /** Commands this agent understands (JobMessage.cmd); missing: none */
    commands?: AgentCommand[];
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
    };
}

/** A package of the operating system that can be upgraded, from a line of `apt list --upgradeable` */
export interface OsPackage {
    name: string;
    /** Version after the upgrade */
    version?: string;
    /** Installed version */
    from?: string;
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
    const m = /^([a-z0-9][a-z0-9+.-]*)\/\S*\s+(\S+)(?:.*\[[^\]:]*:\s*([^\]\s]+)\])?/i.exec(line.trim());
    if (!m) {
        return null;
    }
    return { name: m[1], version: m[2], ...(m[3] ? { from: m[3] } : {}) };
}

/** Instance id as the commands accept it, e.g. "javascript.0" */
export const INSTANCE_ID = /^[a-z0-9][a-z0-9_-]*\.\d{1,4}$/;

export type InstanceAction = 'start' | 'stop' | 'restart';

/** Commands from the asset detail an agent may understand (Inventory.commands) */
export type AgentCommand = 'instance' | 'restart' | 'osUpgrade' | 'logs' | 'adapter';

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
     */
    cmd: 'resync' | 'refresh' | 'tunnel' | 'instance' | 'restart' | 'osUpgrade' | 'logList' | 'logFetch' | 'adapter';
    /** For cmd 'tunnel' */
    tunnel?: TunnelRequest;
    /** Commands: the agent answers on topic reply with this reference */
    ref?: string;
    /** Who asked, for the log on the device */
    by?: string;
    /** For cmd 'instance' */
    instance?: { id: string; action: InstanceAction };
    /** For cmd 'osUpgrade': names out of OsUpdates.packages (the agent takes no others); restart ioBroker after it */
    osUpgrade?: { packages: string[]; restart: boolean };
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
}

/**
 * Kinds of remote access through the tunnel: the web interfaces admin, and web with vis-2, and a shell on the
 * device (console; off unless the owner switches it on, see tunnel.ts for its messages)
 */
export type AccessKind = 'admin' | 'vis' | 'console';
export const ACCESS_KINDS: AccessKind[] = ['admin', 'vis', 'console'];

/** A local web interface the agent can carry a remote access to (Inventory.accessTargets) */
export interface AccessInstance {
    /** e.g. "admin.1", "web.0" */
    instance: string;
    port: number;
    /** HTTPS (instance setting "secure") */
    secure: boolean;
    /** Login required (instance setting "auth") */
    auth: boolean;
    /** Without login every request runs as this user (instance setting "defaultUser") */
    defaultUser?: string;
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
    /** Instance to connect to, one of Inventory.accessTargets of this kind; missing: the first one */
    instance?: string;
}

export type JobState =
    'assigned' | 'waiting' | 'preflight' | 'blocked' | 'backup' | 'rollout' | 'verify' | 'done' | 'rollback';

export const TERMINAL_JOB_STATES: JobState[] = ['done', 'blocked'];

/**
 * A step of a job. node: Node.js to the major line of the profile (from: process.version, to: the major,
 * e.g. "22"); it comes right after the backup and stays when a later step fails.
 */
export interface JobStep {
    action: 'backup' | 'node' | 'install' | 'upgrade' | 'downgrade' | 'remove';
    adapter?: string;
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
