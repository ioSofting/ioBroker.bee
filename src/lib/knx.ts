import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Timers } from './util';

/**
 * KNX for ETS from afar: the fleet management carries the connections of ETS (through the program bee-knx on
 * the PC of the technician) to the KNX/IP gateway in the LAN of this system. Only to that one gateway: it is set
 * here, never by the server.
 *
 * A stream of the tunnel carries KNXnet/IP frames back to back, as KNXnet/IP over TCP does: every frame starts
 * with the header, which holds the total length, and the HPAIs say "TCP, 0.0.0.0:0" (the answer goes back on
 * the same connection). A gateway with TCP gets the bytes as they are. A gateway with UDP only gets each frame
 * as a datagram, with the HPAIs set to the address of this agent, and the data endpoint of the gateway (from
 * CONNECT_RESPONSE) is kept here instead of being passed on.
 */

export const KNX_PORT = 3671;
export type KnxTransport = 'auto' | 'tcp' | 'udp';

export interface KnxGateway {
    host: string;
    port: number;
    transport: KnxTransport;
}

/** KNXnet/IP service types used here */
export const SERVICE = {
    SEARCH_REQUEST: 0x0201,
    SEARCH_RESPONSE: 0x0202,
    DESCRIPTION_REQUEST: 0x0203,
    CONNECT_REQUEST: 0x0205,
    CONNECT_RESPONSE: 0x0206,
    CONNECTIONSTATE_REQUEST: 0x0207,
    DISCONNECT_REQUEST: 0x0209,
    DISCONNECT_RESPONSE: 0x020a,
    SEARCH_REQUEST_EXT: 0x020b,
    SEARCH_RESPONSE_EXT: 0x020c,
    DEVICE_CONFIGURATION_REQUEST: 0x0310,
    DEVICE_CONFIGURATION_ACK: 0x0311,
    TUNNELLING_REQUEST: 0x0420,
    TUNNELLING_ACK: 0x0421,
    TUNNELLING_FEATURE_GET: 0x0422,
    TUNNELLING_FEATURE_RESPONSE: 0x0423,
    TUNNELLING_FEATURE_SET: 0x0424,
    TUNNELLING_FEATURE_INFO: 0x0425,
} as const;

const HEADER_LENGTH = 6;
const PROTOCOL_VERSION = 0x10;
/** Larger than any KNXnet/IP frame; a stream with a larger one is broken */
const MAX_FRAME = 4096;
const HPAI_UDP = 0x01;
const HPAI_TCP = 0x02;
/** Connections of ETS per session at the same time (ETS needs one; a gateway has only a few tunnels) */
export const MAX_KNX_STREAMS = 4;
/** How long a TCP connect to the gateway may take before "auto" takes UDP */
const TCP_PROBE_MS = 2000;

/** Services that go to the data endpoint of a tunnel (connection header: length, channel, sequence, status) */
const DATA_SERVICES = new Set<number>([
    SERVICE.TUNNELLING_REQUEST,
    SERVICE.TUNNELLING_ACK,
    SERVICE.DEVICE_CONFIGURATION_REQUEST,
    SERVICE.DEVICE_CONFIGURATION_ACK,
    SERVICE.TUNNELLING_FEATURE_GET,
    SERVICE.TUNNELLING_FEATURE_RESPONSE,
    SERVICE.TUNNELLING_FEATURE_SET,
    SERVICE.TUNNELLING_FEATURE_INFO,
]);

/** Offsets of the HPAIs a client sends, from the start of the frame */
const REQUEST_HPAIS: Record<number, number[]> = {
    [SERVICE.SEARCH_REQUEST]: [6],
    [SERVICE.SEARCH_REQUEST_EXT]: [6],
    [SERVICE.DESCRIPTION_REQUEST]: [6],
    [SERVICE.CONNECT_REQUEST]: [6, 14],
    [SERVICE.CONNECTIONSTATE_REQUEST]: [8],
    [SERVICE.DISCONNECT_REQUEST]: [8],
};

/**
 * "192.168.1.20", "knx-gw.local:3672"; null if empty or not a host. Without scheme, path or spaces: this is
 * the only place the agent connects to for KNX.
 */
export function parseGateway(text: unknown, transport: unknown = 'auto'): KnxGateway | null {
    const s = typeof text === 'string' ? text.trim() : '';
    const m = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(s);
    if (!m) {
        return null;
    }
    const port = m[2] ? parseInt(m[2], 10) : KNX_PORT;
    if (port < 1 || port > 65535) {
        return null;
    }
    const t: KnxTransport = transport === 'tcp' || transport === 'udp' ? transport : 'auto';
    return { host: m[1], port, transport: t };
}

export function gatewayText(gw: KnxGateway): string {
    return `${gw.host}${gw.port === KNX_PORT ? '' : `:${gw.port}`}`;
}

/**
 * The gateway: as set in the instance of bee, otherwise as the enabled instance of knx or openknx on this host
 * has it (native.gwip, native.gwipport).
 */
export async function findGateway(
    adapter: ioBroker.Adapter,
    own: string,
    transport: KnxTransport,
): Promise<KnxGateway | null> {
    const set = parseGateway(own, transport);
    if (set) {
        return set;
    }
    for (const name of ['knx', 'openknx']) {
        let rows: { value: unknown }[];
        try {
            rows = (
                await adapter.getObjectViewAsync('system', 'instance', {
                    startkey: `system.adapter.${name}.`,
                    endkey: `system.adapter.${name}.香`,
                })
            ).rows;
        } catch {
            continue;
        }
        const objects = rows
            .map(r => r.value as ioBroker.InstanceObject | undefined)
            .filter((o): o is ioBroker.InstanceObject => !!o?.common.enabled && o.common.host === adapter.host)
            .sort((a, b) => a._id.localeCompare(b._id, undefined, { numeric: true }));
        for (const obj of objects) {
            const native = obj.native as { gwip?: string; gwipport?: number | string };
            const gw = parseGateway(
                native.gwipport && Number(native.gwipport) !== KNX_PORT
                    ? `${native.gwip}:${native.gwipport}`
                    : native.gwip,
                transport,
            );
            if (gw) {
                return gw;
            }
        }
    }
    return null;
}

/** Splits a byte stream into KNXnet/IP frames */
export class FrameReader {
    private buf: Buffer = Buffer.alloc(0);

    constructor(private readonly onFrame: (frame: Buffer) => void) {}

    /** @returns false if the stream is broken (no KNXnet/IP header); then nothing more comes out */
    push(chunk: Buffer): boolean {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        while (this.buf.length >= HEADER_LENGTH) {
            const length = this.buf.readUInt16BE(4);
            if (
                this.buf[0] !== HEADER_LENGTH ||
                this.buf[1] !== PROTOCOL_VERSION ||
                length < HEADER_LENGTH ||
                length > MAX_FRAME
            ) {
                this.buf = Buffer.alloc(0);
                return false;
            }
            if (this.buf.length < length) {
                break;
            }
            // a copy: the frame is changed in place and may be kept by dgram
            const frame = Buffer.from(this.buf.subarray(0, length));
            this.buf = this.buf.subarray(length);
            this.onFrame(frame);
        }
        return true;
    }
}

/** Writes an HPAI (length 8) at the offset, if one is there */
export function setHpai(frame: Buffer, offset: number, protocol: number, ip = '0.0.0.0', port = 0): void {
    if (frame.length < offset + 8 || frame[offset] !== 8) {
        return;
    }
    frame[offset + 1] = protocol;
    const parts = ip.split('.').map(n => parseInt(n, 10) & 0xff);
    for (let i = 0; i < 4; i++) {
        frame[offset + 2 + i] = parts[i] ?? 0;
    }
    frame.writeUInt16BE(port, offset + 6);
}

function hpaiAddress(frame: Buffer, offset: number): { address: string; port: number } {
    return {
        address: [...frame.subarray(offset + 2, offset + 6)].join('.'),
        port: frame.readUInt16BE(offset + 6),
    };
}

function disconnectRequest(channel: number, ip: string, port: number): Buffer {
    const frame = Buffer.from([
        HEADER_LENGTH,
        PROTOCOL_VERSION,
        0x02,
        0x09,
        0x00,
        0x10,
        channel,
        0,
        8,
        HPAI_UDP,
        0,
        0,
        0,
        0,
        0,
        0,
    ]);
    setHpai(frame, 8, HPAI_UDP, ip, port);
    return frame;
}

export interface KnxRelayOptions {
    log: ioBroker.Logger;
    timers: Timers;
    /** Called once the relay is over */
    onEnd?: () => void;
}

/** TCP or UDP for this gateway: "auto" tries TCP once and remembers the answer for the session */
export class KnxConnector {
    private chosen: 'tcp' | 'udp' | null;

    constructor(
        readonly gateway: KnxGateway,
        private readonly opts: KnxRelayOptions,
    ) {
        this.chosen = gateway.transport === 'auto' ? null : gateway.transport;
    }

    /** Carries one stream of ETS to the gateway */
    relay(stream: Duplex, onEnd?: () => void): void {
        let ended = false;
        const end = (): void => {
            if (!ended) {
                ended = true;
                onEnd?.();
            }
        };
        stream.on('close', end);
        stream.on('error', () => {});
        if (this.chosen === 'udp') {
            void relayUdp(stream, this.gateway, this.opts);
            return;
        }
        const socket = net.connect({ host: this.gateway.host, port: this.gateway.port });
        socket.setNoDelay(true);
        let connected = false;
        const probe =
            this.chosen === null
                ? this.opts.timers.setTimeout(() => socket.destroy(new Error('timeout')), TCP_PROBE_MS)
                : undefined;
        socket.once('connect', () => {
            connected = true;
            this.opts.timers.clearTimeout(probe);
            if (this.chosen !== 'tcp') {
                this.opts.log.debug(`KNX: gateway ${gatewayText(this.gateway)} speaks TCP`);
            }
            this.chosen = 'tcp';
            stream.pipe(socket);
            socket.pipe(stream);
        });
        socket.once('error', err => {
            this.opts.timers.clearTimeout(probe);
            if (this.chosen === null && !connected) {
                this.opts.log.debug(`KNX: no TCP at ${gatewayText(this.gateway)} (${err.message}), taking UDP`);
                this.chosen = 'udp';
                void relayUdp(stream, this.gateway, this.opts);
                return;
            }
            this.opts.log.info(`KNX: gateway ${gatewayText(this.gateway)}: ${err.message}`);
            stream.destroy(new Error(`KNX-Gateway: ${err.message}`));
        });
        socket.on('close', () => {
            if (this.chosen === 'tcp') {
                stream.end();
            }
        });
        stream.on('close', () => socket.destroy());
    }
}

/** The address of this host towards the gateway (for the HPAIs of UDP) */
async function localAddressTowards(ip: string, port: number): Promise<string> {
    const probe = dgram.createSocket('udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            probe.once('error', reject);
            probe.connect(port, ip, () => resolve());
        });
        return probe.address().address;
    } finally {
        probe.close();
    }
}

/** One stream to a gateway with UDP only */
export async function relayUdp(
    stream: Duplex,
    gw: KnxGateway,
    opts: Pick<KnxRelayOptions, 'log' | 'timers'>,
): Promise<void> {
    const log = opts.log;
    let gatewayIp: string;
    let localIp: string;
    try {
        gatewayIp = net.isIPv4(gw.host) ? gw.host : (await lookup(gw.host, { family: 4 })).address;
        localIp = await localAddressTowards(gatewayIp, gw.port);
    } catch (e) {
        stream.destroy(new Error(`KNX-Gateway ${gatewayText(gw)} nicht erreichbar: ${(e as Error).message}`));
        return;
    }
    const socket = dgram.createSocket('udp4');
    /** Data endpoints of the gateway per channel, from CONNECT_RESPONSE */
    const channels = new Map<number, { address: string; port: number }>();
    let closed = false;
    const control = { address: gatewayIp, port: gw.port };
    await new Promise<void>(resolve => socket.bind(0, resolve));
    const localPort = socket.address().port;
    log.debug(`KNX: UDP ${localIp}:${localPort} <-> ${gatewayIp}:${gw.port}`);

    const close = (): void => {
        if (closed) {
            return;
        }
        closed = true;
        // free the tunnels of the gateway (it has only a few) instead of waiting for its timeout of 120 s
        for (const channel of channels.keys()) {
            socket.send(disconnectRequest(channel, localIp, localPort), control.port, control.address);
        }
        if (!opts.timers.setTimeout(() => socket.close(), 200)) {
            // the adapter stops: no time left for the answers
            socket.close();
        }
        if (!stream.destroyed) {
            stream.destroy();
        }
    };

    const reader = new FrameReader(frame => {
        const type = frame.readUInt16BE(2);
        for (const offset of REQUEST_HPAIS[type] ?? []) {
            setHpai(frame, offset, HPAI_UDP, localIp, localPort);
        }
        const to = DATA_SERVICES.has(type) && frame.length > 7 ? (channels.get(frame[7]) ?? control) : control;
        socket.send(frame, to.port, to.address);
    });
    stream.on('data', (chunk: Buffer) => {
        if (!reader.push(chunk)) {
            log.info('KNX: invalid data from ETS, connection closed');
            close();
        }
    });
    stream.on('end', close);
    stream.on('close', close);
    stream.on('error', close);
    socket.on('error', err => {
        log.info(`KNX: UDP: ${err.message}`);
        close();
    });
    socket.on('message', (msg, rinfo) => {
        // only the gateway, only whole frames
        if (
            closed ||
            rinfo.address !== gatewayIp ||
            msg.length < HEADER_LENGTH ||
            msg[0] !== HEADER_LENGTH ||
            msg.readUInt16BE(4) !== msg.length
        ) {
            return;
        }
        const type = msg.readUInt16BE(2);
        if (type === SERVICE.CONNECT_RESPONSE && msg.length >= 16 && msg[7] === 0) {
            const data = hpaiAddress(msg, 8);
            channels.set(msg[6], {
                address: data.address === '0.0.0.0' ? rinfo.address : data.address,
                port: data.port || rinfo.port,
            });
            setHpai(msg, 8, HPAI_TCP);
        } else if (type === SERVICE.SEARCH_RESPONSE || type === SERVICE.SEARCH_RESPONSE_EXT) {
            setHpai(msg, 6, HPAI_TCP);
        } else if (type === SERVICE.DISCONNECT_RESPONSE || type === SERVICE.DISCONNECT_REQUEST) {
            channels.delete(msg[6]);
        }
        stream.write(msg);
    });
}
