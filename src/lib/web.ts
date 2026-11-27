import { lookup } from 'node:dns/promises';
import { inNetwork, ipv4, isPrivate } from './lan';
import { MAX_WEB_DEVICES, type AccessInstance } from './protocol';
import type { AccessTarget } from './remote';

/**
 * Web interfaces of devices in the network (remote access of kind web): the owner lists them in the instance of bee,
 * one line per device with a name and its address, e.g. "Router | 192.168.0.1", "Wechselrichter | 192.168.0.20:8080"
 * or "Kamera | https://192.168.0.30". The fleet management opens one by its name in the browser, as admin; the address
 * comes from this table, never from the server. Only private addresses and this system itself (127.x): the tunnel
 * never leads into the internet.
 */

/** A line of the table, checked */
export interface WebDevice {
    name: string;
    /** IPv4 address or host name, as entered, without scheme and port */
    address: string;
    port: number;
    secure: boolean;
}

const MAX_NAME = 60;
const HOST_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Private networks, this system (127/8) and link-local (169.254/16, e.g. a device without DHCP) */
export function reachableIp(ip: number): boolean {
    return isPrivate(ip) || inNetwork(ip, '127.0.0.0/8') || inNetwork(ip, '169.254.0.0/16');
}

/**
 * "192.168.0.10:8080", "https://192.168.0.30", "fritz.box" → address, port and HTTPS. Without port 80, or 443 with
 * https://; port 443 without scheme means HTTPS.
 *
 * @returns why the address is not usable
 */
export function parseWebAddress(text: unknown): Omit<WebDevice, 'name'> | string {
    const raw = typeof text === 'string' ? text.trim() : '';
    const m = /^(?:(https?):\/\/)?([^\s/:?#@]+)(?::(\d{1,5}))?\/?$/i.exec(raw);
    if (!m) {
        return raw ? `${raw}: als IP:Port angeben, z. B. 192.168.0.10:80` : 'Adresse fehlt';
    }
    const scheme = m[1]?.toLowerCase();
    const address = m[2].toLowerCase();
    const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80;
    if (port < 1 || port > 65535) {
        return `${raw}: Port von 1 bis 65535`;
    }
    const ip = ipv4(address);
    if (ip === null && (/^[\d.]+$/.test(address) || !HOST_NAME.test(address))) {
        return `${raw}: keine IPv4-Adresse und kein Hostname`;
    }
    // a host name is checked when it is resolved (resolveWebDevice)
    if (ip !== null && !reachableIp(ip)) {
        return `${raw}: nur private Adressen (10.x, 172.16–31.x, 192.168.x) oder dieses System (127.0.0.1)`;
    }
    return { address, port, secure: scheme ? scheme === 'https' : port === 443 };
}

/**
 * The table "Weboberflächen im Netz" of the instance: the usable lines, and why the others are not (for the log).
 * Empty lines are skipped; a name only once (whatever the case).
 */
export function webDevices(raw: unknown): { devices: WebDevice[]; errors: string[] } {
    const devices: WebDevice[] = [];
    const errors: string[] = [];
    for (const [i, row] of (Array.isArray(raw) ? raw : []).entries()) {
        const r = (row ?? {}) as { name?: unknown; address?: unknown };
        // control characters would break the log and the status of the instance
        const name = Array.from(typeof r.name === 'string' ? r.name : '')
            .filter(c => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f)
            .join('')
            .trim();
        const address = typeof r.address === 'string' ? r.address.trim() : '';
        if (!name && !address) {
            continue;
        }
        const line = `Zeile ${i + 1}${name ? ` (${name})` : ''}`;
        if (!name) {
            errors.push(`${line}: Name fehlt`);
            continue;
        }
        if (name.length > MAX_NAME) {
            errors.push(`${line}: Name länger als ${MAX_NAME} Zeichen`);
            continue;
        }
        if (devices.some(d => d.name.toLowerCase() === name.toLowerCase())) {
            errors.push(`${line}: der Name steht schon in einer Zeile davor`);
            continue;
        }
        if (devices.length >= MAX_WEB_DEVICES) {
            errors.push(`${line}: höchstens ${MAX_WEB_DEVICES} Weboberflächen`);
            continue;
        }
        const parsed = parseWebAddress(address);
        if (typeof parsed === 'string') {
            errors.push(`${line}: ${parsed}`);
            continue;
        }
        devices.push({ name, ...parsed });
    }
    return { devices, errors };
}

/** What the fleet management learns about the devices (Inventory.accessTargets.web): name, address, port, HTTPS */
export function describeWebDevices(devices: WebDevice[]): AccessInstance[] {
    return devices.map(d => ({ instance: d.name, port: d.port, secure: d.secure, auth: false, address: d.address }));
}

/**
 * Where the streams of a session go: the address of the device, a host name resolved now and only to a private
 * address or this system
 *
 * @returns why the device cannot be reached
 */
export async function resolveWebDevice(
    d: WebDevice,
    resolve: (host: string) => Promise<string> = async host => (await lookup(host, { family: 4 })).address,
): Promise<AccessTarget | string> {
    let host = d.address;
    if (ipv4(host) === null) {
        try {
            host = await resolve(d.address);
        } catch (e) {
            return `${d.address} ist im Netz nicht zu finden (${(e as NodeJS.ErrnoException).code || (e as Error).message})`;
        }
        const ip = ipv4(host);
        if (ip === null || !reachableIp(ip)) {
            return `${d.address} zeigt auf ${host}, keine private Adresse`;
        }
    }
    return {
        instance: d.name,
        host,
        port: d.port,
        secure: d.secure,
        auth: false,
        // HTTPS: the name for SNI, never an IP address (not allowed there)
        ...(d.secure && host !== d.address ? { servername: d.address } : {}),
    };
}
