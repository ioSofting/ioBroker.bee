import { connect, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { MAX_LAN_PORTS, type LanInfo, type LanTarget } from './protocol';

/**
 * Devices in the network (remote access of kind lan): a LOGO! or an S7 that the service programs with its own tool,
 * through the tunnel. The fleet management names the device (address and ports, from the list of the asset); what may
 * be reached decides the owner here: the switch, the networks (default: the own subnets) and the ports. Never the
 * device itself, never a public address.
 */

/** Connections of the tool per session at the same time; LOGO!Soft and TIA open a few */
export const MAX_LAN_STREAMS = 16;
const CONNECT_TIMEOUT_MS = 10_000;

/** "192.168.0.3" → number; null: not an IPv4 address */
export function ipv4(text: unknown): number | null {
    const m = typeof text === 'string' ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text.trim()) : null;
    if (!m) {
        return null;
    }
    const parts = m.slice(1).map(Number);
    return parts.some(p => p > 255) ? null : ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function maskOf(bits: number): number {
    return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

/** Whether the address is in the network "192.168.0.0/24" (a single address without /32) */
export function inNetwork(ip: number, cidr: string): boolean {
    const [base, bits = '32'] = cidr.split('/');
    const net = ipv4(base);
    const len = Number(bits);
    if (net === null || !Number.isInteger(len) || len < 0 || len > 32) {
        return false;
    }
    return (ip & maskOf(len)) >>> 0 === (net & maskOf(len)) >>> 0;
}

/** 10/8, 172.16/12, 192.168/16 */
export function isPrivate(ip: number): boolean {
    return inNetwork(ip, '10.0.0.0/8') || inNetwork(ip, '172.16.0.0/12') || inNetwork(ip, '192.168.0.0/16');
}

function dotted(ip: number): string {
    return [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');
}

/** The IPv4 addresses of this device and their subnets, e.g. "192.168.0.0/24" */
export function ownNetworks(ifaces = networkInterfaces()): { addresses: string[]; subnets: string[] } {
    const addresses: string[] = [];
    const subnets: string[] = [];
    for (const list of Object.values(ifaces)) {
        for (const a of list ?? []) {
            if (a.family !== 'IPv4' || a.internal) {
                continue;
            }
            addresses.push(a.address);
            const ip = ipv4(a.address);
            const bits = a.cidr ? Number(a.cidr.split('/')[1]) : NaN;
            if (ip !== null && isPrivate(ip) && Number.isInteger(bits) && bits >= 8) {
                const net = `${dotted((ip & maskOf(bits)) >>> 0)}/${bits}`;
                if (!subnets.includes(net)) {
                    subnets.push(net);
                }
            }
        }
    }
    return { addresses, subnets };
}

/** "192.168.0.0/24, 10.1.2.3" from the instance: only private networks; a single address counts as /32 */
export function parseNetworks(text: unknown): string[] {
    const list: string[] = [];
    for (const part of (typeof text === 'string' ? text : '').split(/[\s,;]+/)) {
        const [base, bits = '32'] = part.split('/');
        const ip = ipv4(base);
        const len = Number(bits);
        if (ip === null || !Number.isInteger(len) || len < 8 || len > 32 || !isPrivate(ip)) {
            continue;
        }
        const net = `${dotted((ip & maskOf(len)) >>> 0)}/${len}`;
        if (!list.includes(net)) {
            list.push(net);
        }
    }
    return list;
}

/** "102, 10005" from the instance; empty: any port (null) */
export function parsePorts(text: unknown): number[] | null {
    const list = (typeof text === 'string' ? text : '')
        .split(/[\s,;]+/)
        .filter(Boolean)
        .map(Number)
        .filter(p => Number.isInteger(p) && p > 0 && p < 65536);
    return list.length ? [...new Set(list)] : null;
}

/** What the owner allows (Inventory.lan): the networks set, or the own subnets */
export function lanInfo(
    config: { allowLan?: boolean; lanNetworks?: string; lanPorts?: string },
    own = ownNetworks(),
): LanInfo {
    const networks = parseNetworks(config.lanNetworks);
    return {
        devices: config.allowLan === true,
        networks: networks.length ? networks : own.subnets,
        ports: parsePorts(config.lanPorts),
    };
}

/**
 * Why an address may not be reached (a device of kind lan, or a KNX gateway named by the server)
 *
 * @returns null if it may
 */
export function addressRefusal(host: string, info: LanInfo, ownAddresses: string[]): string | null {
    const ip = ipv4(host);
    if (ip === null) {
        return `${host} ist keine IPv4-Adresse`;
    }
    if (!isPrivate(ip)) {
        return `${host} ist keine private Adresse`;
    }
    if (ownAddresses.includes(host.trim())) {
        return `${host} ist das Gerät selbst`;
    }
    if (!info.networks.some(n => inNetwork(ip, n))) {
        return `${host} liegt außerhalb des erlaubten Netzes (${info.networks.join(', ') || 'keins'})`;
    }
    return null;
}

/** Why a device in the network may not be reached; null: it may */
export function targetRefusal(t: LanTarget | undefined, info: LanInfo, ownAddresses: string[]): string | null {
    if (!info.devices) {
        return 'Geräte im Netz sind am Gerät nicht freigegeben';
    }
    if (
        !t ||
        typeof t.host !== 'string' ||
        !Array.isArray(t.ports) ||
        !t.ports.length ||
        t.ports.length > MAX_LAN_PORTS
    ) {
        return 'Kein gültiges Gerät angegeben';
    }
    const refusal = addressRefusal(t.host, info, ownAddresses);
    if (refusal) {
        return refusal;
    }
    const closed = t.ports.filter(
        p => !Number.isInteger(p) || p < 1 || p > 65535 || (info.ports && !info.ports.includes(p)),
    );
    return closed.length
        ? `${closed.length === 1 ? 'Port' : 'Ports'} ${closed.join(', ')} am Gerät nicht erlaubt`
        : null;
}

/**
 * One connection of the tool: the stream of the tunnel to the device on `port`
 *
 * @param stream the stream of the tunnel
 * @param host address of the device
 * @param port port of the device
 * @param onEnd called once, when the connection is over; with the error, if there was one
 */
export function relayTcp(stream: Duplex, host: string, port: number, onEnd: (error?: string) => void): void {
    let done = false;
    const finish = (error?: string): void => {
        if (!done) {
            done = true;
            onEnd(error);
        }
    };
    stream.on('error', () => {});
    stream.on('close', () => finish());
    const socket: Socket = connect({ host, port, timeout: CONNECT_TIMEOUT_MS });
    socket.setNoDelay(true);
    socket.once('connect', () => {
        socket.setTimeout(0);
        stream.pipe(socket);
        socket.pipe(stream);
    });
    socket.once('timeout', () => socket.destroy(new Error(`${host}:${port} antwortet nicht`)));
    socket.once('error', err => {
        finish(err.message);
        stream.destroy(new Error(`${host}:${port}: ${err.message}`));
    });
    // the device closed: the rest goes through, then the stream ends (half close as in TCP)
    socket.on('close', hadError => {
        if (!hadError) {
            stream.end();
        }
    });
    stream.on('close', () => socket.destroy());
}
