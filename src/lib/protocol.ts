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
 *   fleet/<tenant>/<device>/desired    server -> device  desired state, RETAINED
 *   fleet/<tenant>/<device>/job        server -> device  one-shot requests (resync, refresh)
 *   fleet/<tenant>/control             server -> device  fleet-wide control (emergency stop), RETAINED
 *
 * Payloads are JSON, gzip-compressed. Receivers accept plain JSON as well.
 *
 * Remote access to admin and vis-2 does not run over MQTT: on a job "tunnel" the agent opens a
 * WebSocket to TUNNEL_PATH of the server and carries the connections of the browser (see tunnel.ts).
 */

export const PROTOCOL_VERSION = 1;

export type Topic = 'state' | 'inventory' | 'result' | 'desired' | 'job';

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
    mode: 'managed' | 'self';
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
    cmd: 'resync' | 'refresh' | 'tunnel';
    /** For cmd 'tunnel' */
    tunnel?: TunnelRequest;
}

/** Web interfaces reachable through the tunnel: admin, or web with vis-2 */
export type AccessKind = 'admin' | 'vis';
export const ACCESS_KINDS: AccessKind[] = ['admin', 'vis'];

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
}

export type JobState =
    'assigned' | 'waiting' | 'preflight' | 'blocked' | 'backup' | 'rollout' | 'verify' | 'done' | 'rollback';

export const TERMINAL_JOB_STATES: JobState[] = ['done', 'blocked'];

export interface JobStep {
    action: 'backup' | 'install' | 'upgrade' | 'downgrade' | 'remove';
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
