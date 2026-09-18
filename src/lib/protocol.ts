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
 */

export const PROTOCOL_VERSION = 1;

export type Topic = 'state' | 'inventory' | 'result' | 'desired' | 'job';

export function deviceTopic(tenantId: string, deviceId: string, topic: Topic): string {
    return `fleet/${tenantId}/${deviceId}/${topic}`;
}

export function controlTopic(tenantId: string): string {
    return `fleet/${tenantId}/control`;
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

/** Slowly changing inventory. Volatile metrics belong into StateMessage. */
export interface Inventory {
    agentVersion: string;
    uuid: string;
    hostname: string;
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
        /** Sectors written to the SD card since boot, if readable */
        sdWrites?: number | null;
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
    cmd: 'resync' | 'refresh';
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
