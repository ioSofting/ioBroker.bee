/**
 * Stream multiplexer of the remote access tunnel.
 *
 * This file exists in both repositories: beekeeper-server/src/tunnel.ts and ioBroker.bee/src/lib/tunnel.ts.
 * Both copies must stay identical; it imports nothing but Node.js.
 *
 * One WebSocket between agent and server carries all connections of the browser (admin and vis-2 open
 * several at once, plus their own WebSocket). Every binary WebSocket message is one frame:
 *
 *   type (1 byte) | stream id (4 bytes, big endian) | payload
 *
 *   OPEN   server -> agent  new stream; the agent connects it to the local web interface
 *   DATA   both             bytes of the stream, at most MAX_PAYLOAD
 *   END    both             no more bytes in this direction (half close)
 *   RESET  both             abort; payload: reason (UTF-8)
 *   ACK    both             payload: 4 bytes, number of received bytes passed on
 *
 * Flow control per stream: a side sends at most WINDOW bytes the other side has not acknowledged.
 * A slow browser or a slow local interface stalls only its own stream, not the tunnel, and neither
 * side buffers more than WINDOW bytes per stream.
 */
import { Duplex } from 'node:stream';

export const FRAME = { OPEN: 1, DATA: 2, END: 3, RESET: 4, ACK: 5 } as const;
export const WINDOW = 256 * 1024;
export const MAX_PAYLOAD = 32 * 1024;
const ACK_THRESHOLD = 64 * 1024;

/**
 * Header of the tunnel request with which the agent refuses a session (URI-encoded reason), e.g. because
 * the owner does not allow this kind of access. The server answers 403 and ends the session.
 */
export const REFUSE_HEADER = 'x-bee-refused';

/** WebSocket close codes of the tunnel connection */
export const CLOSE = {
    /** The session ended (operator, expiry, server stop): do not reconnect */
    ENDED: 4000,
    /** The agent refuses: the owner does not allow this kind of access */
    NOT_ALLOWED: 4003,
    /** The agent finds no local web interface of this kind */
    NO_TARGET: 4004,
    /** Another connection of the same session took over */
    REPLACED: 4009,
} as const;

function frame(type: number, id: number, payload?: Buffer): Buffer {
    const buf = Buffer.allocUnsafe(5 + (payload?.length ?? 0));
    buf[0] = type;
    buf.writeUInt32BE(id, 1);
    payload?.copy(buf, 5);
    return buf;
}

/** One connection of the browser inside the tunnel */
export class TunnelStream extends Duplex {
    /** Bytes this side may still send */
    private credit = WINDOW;
    /** Write waiting for credit */
    private pending: { chunk: Buffer; callback: (err?: Error | null) => void } | null = null;
    /** Received bytes passed on but not yet acknowledged */
    private unacked = 0;
    /** The reader did not take everything: acknowledge once it asks for more */
    private paused = false;
    private sentEnd = false;
    private gotEnd = false;
    private gotReset = false;

    constructor(
        private readonly mux: Mux,
        readonly id: number,
    ) {
        super({ allowHalfOpen: true });
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
        this.send(chunk, callback);
    }

    private send(chunk: Buffer, callback: (err?: Error | null) => void): void {
        while (chunk.length) {
            const n = Math.min(chunk.length, this.credit, MAX_PAYLOAD);
            if (n <= 0) {
                this.pending = { chunk, callback };
                return;
            }
            this.mux.sendFrame(FRAME.DATA, this.id, chunk.subarray(0, n));
            this.mux.bytesOut += n;
            this.credit -= n;
            chunk = chunk.subarray(n);
        }
        callback();
    }

    override _final(callback: (err?: Error | null) => void): void {
        this.sentEnd = true;
        this.mux.sendFrame(FRAME.END, this.id);
        callback();
    }

    override _read(): void {
        if (this.paused) {
            this.paused = false;
            this.ack(true);
        }
    }

    override _destroy(err: Error | null, callback: (err: Error | null) => void): void {
        if (!this.gotReset && !(this.sentEnd && this.gotEnd)) {
            this.mux.sendFrame(FRAME.RESET, this.id, Buffer.from(err?.message || 'closed'));
        }
        this.mux.forget(this.id);
        const pending = this.pending;
        this.pending = null;
        pending?.callback(err || new Error('stream closed'));
        callback(err);
    }

    private ack(force: boolean): void {
        if (this.paused || !this.unacked || this.destroyed || (!force && this.unacked < ACK_THRESHOLD)) {
            return;
        }
        const payload = Buffer.allocUnsafe(4);
        payload.writeUInt32BE(this.unacked, 0);
        this.unacked = 0;
        this.mux.sendFrame(FRAME.ACK, this.id, payload);
    }

    /** Frame from the other side, passed on by the Mux */
    handle(type: number, payload: Buffer): void {
        if (type === FRAME.DATA) {
            if (this.gotEnd) {
                return;
            }
            this.mux.bytesIn += payload.length;
            this.unacked += payload.length;
            if (this.push(payload)) {
                this.ack(false);
            } else {
                this.paused = true;
            }
        } else if (type === FRAME.END) {
            this.gotEnd = true;
            this.push(null);
        } else if (type === FRAME.ACK && payload.length >= 4) {
            this.credit += payload.readUInt32BE(0);
            const pending = this.pending;
            if (pending) {
                this.pending = null;
                this.send(pending.chunk, pending.callback);
            }
        } else if (type === FRAME.RESET) {
            this.gotReset = true;
            this.destroy(new Error(payload.toString('utf8') || 'reset by the other side'));
        }
    }
}

/**
 * Both ends of the tunnel. `send` puts a frame on the WebSocket; frames from the WebSocket go to
 * `receive`. Only the server opens streams; the agent gets them through `onStream`.
 */
export class Mux {
    private readonly streams = new Map<number, TunnelStream>();
    private nextId = 1;
    private closed = false;
    /** Payload bytes received and sent, for the audit log */
    bytesIn = 0;
    bytesOut = 0;

    constructor(
        private readonly send: (frame: Buffer) => void,
        private readonly onStream?: (stream: TunnelStream) => void,
    ) {}

    get size(): number {
        return this.streams.size;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    open(): TunnelStream {
        if (this.closed) {
            throw new Error('tunnel closed');
        }
        const id = this.nextId;
        this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
        const stream = new TunnelStream(this, id);
        this.streams.set(id, stream);
        this.sendFrame(FRAME.OPEN, id);
        return stream;
    }

    receive(buf: Buffer): void {
        if (this.closed || buf.length < 5) {
            return;
        }
        const type = buf[0];
        const id = buf.readUInt32BE(1);
        const payload = buf.subarray(5);
        if (type === FRAME.OPEN) {
            if (!this.onStream || this.streams.has(id)) {
                this.sendFrame(FRAME.RESET, id, Buffer.from('refused'));
                return;
            }
            const stream = new TunnelStream(this, id);
            this.streams.set(id, stream);
            this.onStream(stream);
            return;
        }
        const stream = this.streams.get(id);
        if (stream) {
            stream.handle(type, payload);
        } else if (type === FRAME.DATA) {
            // late data for a stream this side already closed
            this.sendFrame(FRAME.RESET, id, Buffer.from('unknown stream'));
        }
    }

    /** @internal */
    sendFrame(type: number, id: number, payload?: Buffer): void {
        if (!this.closed) {
            this.send(frame(type, id, payload));
        }
    }

    /** @internal */
    forget(id: number): void {
        this.streams.delete(id);
    }

    /** The WebSocket is gone: every stream ends with an error */
    close(reason = 'tunnel closed'): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const stream of [...this.streams.values()]) {
            stream.destroy(new Error(reason));
        }
        this.streams.clear();
    }
}
