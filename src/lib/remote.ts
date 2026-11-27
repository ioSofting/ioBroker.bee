import net from 'node:net';
import tls from 'node:tls';
import WebSocket from 'ws';
import type { AccessInstance, AccessKind, TunnelRequest } from './protocol';
import { CLOSE, Mux, REFUSE_HEADER, type TunnelStream } from './tunnel';
import type { Timers } from './util';

/**
 * Remote access to admin and vis-2 without ioBroker.pro and without open ports: on request of the server
 * (job "tunnel") the agent opens a WebSocket to the server and carries the connections of the browser to
 * the local web interface. Only to that one: the target is chosen here, never by the server.
 * For the console every stream is a shell instead (console.ts).
 */

/** A local web interface, with the address to connect to (stays on the device) */
export interface AccessTarget extends AccessInstance {
    host: string;
}

export const ACCESS_LABEL: Record<AccessKind, string> = {
    admin: 'admin',
    vis: 'vis-2',
    console: 'Konsole',
    knx: 'KNX',
    // the interface of Home Assistant is carried by bee-ha, never by this agent
    ha: 'Home Assistant',
    lan: 'Gerät im Netz',
};

/**
 * Local web interfaces for a kind: the enabled admin instances, or web instances for vis-2 (only with vis-2
 * installed), on this host, in the order of the instance number.
 */
export async function findTargets(adapter: ioBroker.Adapter, kind: AccessKind): Promise<AccessTarget[]> {
    if (
        kind === 'console' ||
        kind === 'knx' ||
        kind === 'ha' ||
        (kind === 'vis' && !(await adapter.getForeignObjectAsync('system.adapter.vis-2')))
    ) {
        return [];
    }
    const name = kind === 'admin' ? 'admin' : 'web';
    const res = await adapter.getObjectViewAsync('system', 'instance', {
        startkey: `system.adapter.${name}.`,
        endkey: `system.adapter.${name}.香`,
    });
    return res.rows
        .map(r => r.value as ioBroker.InstanceObject | undefined)
        .filter((o): o is ioBroker.InstanceObject => !!o?.common.enabled && o.common.host === adapter.host)
        .sort((a, b) => a._id.localeCompare(b._id, undefined, { numeric: true }))
        .map(obj => {
            const native = obj.native as {
                port?: number | string;
                secure?: boolean;
                bind?: string;
                auth?: boolean;
                defaultUser?: string;
            };
            // an interface listening on all addresses is reached over loopback
            const bind = (native.bind || '').trim();
            const defaultUser = (native.defaultUser || 'admin').replace(/^system\.user\./, '');
            return {
                instance: obj._id.replace(/^system\.adapter\./, ''),
                host: !bind || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind,
                port: parseInt(String(native.port || (kind === 'admin' ? 8081 : 8082)), 10),
                secure: !!native.secure,
                auth: !!native.auth,
                ...(native.auth ? {} : { defaultUser }),
            };
        });
}

/** What the server learns about the targets: without the local address */
export function describeTargets(targets: AccessTarget[]): AccessInstance[] {
    return targets.map(({ host: _host, ...t }) => t);
}

/**
 * Projects of vis-2: the folders in the file storage of vis-2.0 that hold a vis-views.json, sorted, at most 100.
 * Empty if vis-2 is not there or the storage cannot be read.
 */
export async function visProjects(adapter: ioBroker.Adapter): Promise<string[]> {
    let entries: ioBroker.ReadDirResult[];
    try {
        entries = await adapter.readDirAsync('vis-2.0', '');
    } catch {
        return [];
    }
    const projects: string[] = [];
    for (const e of entries) {
        if (!e.isDir || projects.length >= 100) {
            continue;
        }
        try {
            if (await adapter.fileExistsAsync('vis-2.0', `${e.file}/vis-views.json`)) {
                projects.push(e.file);
            }
        } catch {
            // not readable: not offered
        }
    }
    return projects.sort((a, b) => a.localeCompare(b));
}

/** The instance asked for, or the first one; null if it is not among the targets */
export function chooseTarget(targets: AccessTarget[], instance: string | undefined): AccessTarget | null {
    return (instance ? targets.find(t => t.instance === instance) : targets[0]) ?? null;
}

/** Is the tunnel URL one of our own server? The job came over the broker, this is a second check. */
export function trustedTunnelUrl(url: string, serverUrls: string[]): boolean {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && local)) {
        return false;
    }
    return serverUrls.some(s => {
        try {
            return new URL(s).hostname === u.hostname;
        } catch {
            return false;
        }
    });
}

export interface TunnelClientOptions {
    /** Where the streams go; null together with a refusal, or with a handler */
    target: AccessTarget | null;
    /** Takes each stream instead of a target (the console) */
    handler?: (stream: TunnelStream) => void;
    /** Reason to refuse the session instead of opening the tunnel */
    refusal: string | null;
    /** Trusted CAs for the server certificate */
    ca: string[];
    log: ioBroker.Logger;
    timers: Timers;
    onEnd: (client: TunnelClient, reason: string) => void;
}

const MAX_BACKOFF = 60_000;
/** The server pings every 25 s; without a ping for this long the connection is dead */
const DEAD_AFTER = 90_000;
/** Longest session the agent accepts, whatever the server says */
const MAX_SESSION = 4 * 3600_000;

/** Tunnel of one access session. Reconnects after a connection loss until the session expires. */
export class TunnelClient {
    private ws: WebSocket | null = null;
    private mux: Mux | null = null;
    private stopped = false;
    private backoff = 2000;
    private retryTimer: ioBroker.Timeout | undefined;
    private readonly endTimer: ioBroker.Timeout | undefined;
    private watchdog: ioBroker.Interval | undefined;
    private lastPing = 0;

    constructor(
        readonly req: TunnelRequest,
        private readonly opts: TunnelClientOptions,
    ) {
        const lifetime = Math.max(0, Math.min(req.expiresAt - Date.now(), MAX_SESSION));
        this.endTimer = opts.timers.setTimeout(() => this.stop('expired'), lifetime);
    }

    /** Payload bytes so far */
    get bytes(): number {
        return (this.mux?.bytesIn ?? 0) + (this.mux?.bytesOut ?? 0);
    }

    start(): void {
        this.connect();
    }

    stop(reason: string): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.opts.timers.clearTimeout(this.endTimer);
        this.opts.timers.clearTimeout(this.retryTimer);
        this.opts.timers.clearInterval(this.watchdog);
        this.mux?.close('Fernzugriff beendet');
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close(1000, 'agent stop');
        } else {
            this.ws?.terminate();
        }
        this.opts.onEnd(this, reason);
    }

    private connect(): void {
        if (this.stopped) {
            return;
        }
        const headers: Record<string, string> = { authorization: `Bearer ${this.req.ticket}` };
        if (this.opts.refusal) {
            headers[REFUSE_HEADER] = encodeURIComponent(this.opts.refusal);
        }
        const ws = new WebSocket(this.req.url, {
            headers,
            ca: this.opts.ca,
            handshakeTimeout: 30_000,
            // mobile data: compress, but cheaply (level 1) for the CPU of the device
            perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 1 } },
        });
        this.ws = ws;
        ws.on('open', () => {
            this.backoff = 2000;
            this.lastPing = Date.now();
            this.mux = new Mux(
                frame => ws.send(frame),
                stream => this.onStream(stream),
            );
            this.watchdog ??= this.opts.timers.setInterval(() => {
                if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastPing > DEAD_AFTER) {
                    this.opts.log.info('Remote access: no sign of the server, reconnecting');
                    this.ws.terminate();
                }
            }, 15_000);
            this.opts.log.debug(`Remote access ${this.req.id}: tunnel open`);
        });
        ws.on('ping', () => (this.lastPing = Date.now()));
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                this.mux?.receive(data as Buffer);
            }
        });
        ws.on('unexpected-response', (_request, res) => {
            res.resume();
            // 410: session unknown or ended, 403: refusal accepted; neither gets better by trying again
            const reason = this.opts.refusal ? 'refused' : `server answered HTTP ${res.statusCode}`;
            this.stop(reason);
        });
        ws.on('error', err => this.opts.log.debug(`Remote access ${this.req.id}: ${err.message}`));
        ws.on('close', code => {
            this.mux?.close('Verbindung zum Server unterbrochen');
            this.mux = null;
            if (this.ws !== ws || this.stopped) {
                return;
            }
            if (code === CLOSE.ENDED || code === CLOSE.REPLACED) {
                this.stop(code === CLOSE.ENDED ? 'ended by the server' : 'replaced');
                return;
            }
            const delay = this.backoff;
            this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
            this.opts.log.info(`Remote access: connection lost, reconnecting in ${Math.round(delay / 1000)} s`);
            this.retryTimer = this.opts.timers.setTimeout(() => {
                this.retryTimer = undefined;
                this.connect();
            }, delay);
        });
    }

    private onStream(stream: TunnelStream): void {
        if (this.opts.handler) {
            this.opts.handler(stream);
            return;
        }
        const t = this.opts.target;
        if (!t) {
            stream.destroy(new Error('no target'));
            return;
        }
        // a local HTTPS interface has its own, usually self-signed certificate: loopback, nothing to verify
        const sock = t.secure
            ? tls.connect({ host: t.host, port: t.port, rejectUnauthorized: false })
            : net.connect(t.port, t.host);
        stream.pipe(sock);
        sock.pipe(stream);
        // a regular end runs through the pipes in both directions (half close); only errors cut off
        sock.on('error', err => stream.destroy(err));
        stream.on('error', () => sock.destroy());
    }
}
