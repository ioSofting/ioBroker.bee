import type { EnrollError, EnrollRequest, EnrollResponse } from './protocol';

/**
 * First contact with the platform. The enrollment URL and a one-time token come with the
 * factory image. The result is a device certificate; the token is used up.
 *
 * - explicit rejection (HTTP 403): the device is unknown -> the agent stops itself
 * - network error, rate limit or server error: try again later with growing distance
 */
export type EnrollResult =
    { kind: 'ok'; creds: EnrollResponse } | { kind: 'rejected'; reason: string } | { kind: 'retry'; reason: string };

export async function enroll(url: string, req: EnrollRequest): Promise<EnrollResult> {
    let res: Response;
    try {
        res = await fetch(`${url.replace(/\/+$/, '')}/api/enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req),
            signal: AbortSignal.timeout(30_000),
        });
    } catch (e) {
        return { kind: 'retry', reason: e.cause?.message || e.message };
    }
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {
        // ignore, handled by status
    }
    if (res.ok) {
        const creds = body as EnrollResponse;
        if (!creds?.deviceId || !creds.cert || !creds.key || !creds.ca || !creds.mqttUrl) {
            return { kind: 'retry', reason: 'Unvollständige Antwort des Servers' };
        }
        return { kind: 'ok', creds };
    }
    const reason = (body as EnrollError | null)?.reason || `HTTP ${res.status}`;
    if (res.status === 403 || res.status === 400) {
        return { kind: 'rejected', reason };
    }
    return { kind: 'retry', reason };
}
