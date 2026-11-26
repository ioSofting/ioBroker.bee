import { createHash } from 'node:crypto';
import type { EnrollResponse } from './protocol';

/**
 * The identity of the device on the platform (device.json in the data folder of the instance).
 * js-controller keeps that folder when the instance is deleted, and the token in the settings
 * is only read for the first enrollment: without a binding, a new instance or a new token would
 * still connect as the old device, to the old tenant.
 */
export interface DeviceFile extends EnrollResponse {
    /** sha256 of the enrollment token the certificate came from */
    tokenHash?: string;
}

export function tokenHash(token: string): string {
    return createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * What to do with the stored identity at the start:
 * - keep: connect as the stored device
 * - adopt: keep it and remember the token (device.json from a version that did not store the hash)
 * - enroll: enroll with the token of the settings (no identity yet, or another token than the one it came from)
 */
export function identityAction(stored: DeviceFile | null, token: string): 'keep' | 'adopt' | 'enroll' {
    token = (token || '').trim();
    if (!stored) {
        return 'enroll';
    }
    if (!token) {
        // the token may be removed from the settings once the device is enrolled
        return 'keep';
    }
    if (stored.tokenHash) {
        return stored.tokenHash === tokenHash(token) ? 'keep' : 'enroll';
    }
    // tokens start with the tenant ("<tenant>.<random>"): one of another tenant is certainly new
    return token.split('.')[0] === stored.tenantId ? 'adopt' : 'enroll';
}
