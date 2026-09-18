import { EventEmitter } from 'node:events';
import mqtt, { type MqttClient } from 'mqtt';
import {
    controlTopic,
    deviceTopic,
    PROTOCOL_VERSION,
    type ControlMessage,
    type DesiredMessage,
    type EnrollResponse,
    type JobMessage,
    type StateMessage,
} from './protocol';
import { decodePayload, encodePayload } from './util';

/**
 * Control channel to the platform broker. MQTT over TLS with the device certificate.
 * Reconnects with exponential backoff up to a daily rhythm: missing network is never
 * a reason to give up. An explicit rejection by the broker is (event "rejected").
 */

export interface TransportEvents {
    connected: [];
    disconnected: [];
    desired: [DesiredMessage | null];
    control: [ControlMessage];
    job: [JobMessage];
    rejected: [string];
}

const MIN_BACKOFF = 10_000;
const MAX_BACKOFF = 24 * 3600_000;

export class Transport extends EventEmitter<TransportEvents> {
    private client: MqttClient | null = null;
    private backoff = MIN_BACKOFF;
    private timer: NodeJS.Timeout | null = null;
    private stopped = false;

    constructor(
        private readonly creds: EnrollResponse,
        private readonly opts: { keepalive: number; log: ioBroker.Logger },
    ) {
        super();
    }

    get connected(): boolean {
        return !!this.client?.connected;
    }

    start(): void {
        this.stopped = false;
        this.connect();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const client = this.client;
        this.client = null;
        if (client) {
            // regular disconnect: publish offline ourselves, the Last Will only fires on connection loss
            if (client.connected) {
                await client
                    .publishAsync(this.topic('state'), encodePayload(this.offline()), { qos: 1 })
                    .catch(() => {});
            }
            await client.endAsync().catch(() => {});
        }
    }

    private topic(t: 'state' | 'inventory' | 'result' | 'desired' | 'job'): string {
        return deviceTopic(this.creds.tenantId, this.creds.deviceId, t);
    }

    private offline(): StateMessage {
        return { v: PROTOCOL_VERSION, ts: Date.now(), online: false };
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.timer) {
            return;
        }
        const delay = Math.round(this.backoff * (0.8 + Math.random() * 0.4));
        this.opts.log.info(`Broker not reachable, next attempt in ${Math.round(delay / 1000)} s`);
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.connect();
        }, delay);
    }

    private connect(): void {
        if (this.stopped) {
            return;
        }
        const client = mqtt.connect(this.creds.mqttUrl, {
            clientId: this.creds.deviceId,
            key: this.creds.key,
            cert: this.creds.cert,
            ca: this.creds.ca,
            rejectUnauthorized: true,
            protocolVersion: 4,
            clean: false,
            keepalive: this.opts.keepalive,
            reconnectPeriod: 0,
            connectTimeout: 30_000,
            will: { topic: this.topic('state'), payload: encodePayload(this.offline()), qos: 1, retain: false },
        });
        this.client = client;
        let rejected = false;

        client.on('connect', () => {
            this.backoff = MIN_BACKOFF;
            client.subscribe(
                [this.topic('desired'), this.topic('job'), controlTopic(this.creds.tenantId)],
                { qos: 1 },
                err => err && this.opts.log.warn(`Subscribe failed: ${err.message}`),
            );
            this.emit('connected');
        });
        client.on('message', (topic, payload) => {
            try {
                if (topic === this.topic('desired')) {
                    this.emit('desired', payload.length ? decodePayload<DesiredMessage>(payload) : null);
                } else if (topic === controlTopic(this.creds.tenantId)) {
                    if (payload.length) {
                        this.emit('control', decodePayload<ControlMessage>(payload));
                    }
                } else if (topic === this.topic('job')) {
                    this.emit('job', decodePayload<JobMessage>(payload));
                }
            } catch (e) {
                this.opts.log.warn(`Invalid message on ${topic}: ${e.message}`);
            }
        });
        client.on('error', err => {
            const code = (err as { code?: number }).code;
            // CONNACK 4/5: the broker knows who we are and says no (certificate revoked)
            if (code === 4 || code === 5 || /Not authorized|Bad username/i.test(err.message)) {
                rejected = true;
                this.stopped = true;
                this.emit('rejected', err.message);
                client.end(true);
                return;
            }
            this.opts.log.debug(`MQTT: ${err.message}`);
        });
        client.on('close', () => {
            if (this.client !== client) {
                return;
            }
            this.emit('disconnected');
            if (!rejected) {
                this.scheduleReconnect();
            }
        });
    }

    async publish(topic: 'state' | 'inventory' | 'result', msg: unknown): Promise<boolean> {
        if (!this.client?.connected) {
            return false;
        }
        try {
            await this.client.publishAsync(this.topic(topic), encodePayload(msg), { qos: 1 });
            return true;
        } catch (e) {
            this.opts.log.debug(`Publish ${topic} failed: ${e.message}`);
            return false;
        }
    }
}
