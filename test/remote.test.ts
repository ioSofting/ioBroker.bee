import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import type { TunnelRequest } from '../src/lib/protocol';
import { findTarget, trustedTunnelUrl, TunnelClient } from '../src/lib/remote';
import { CLOSE, Mux, REFUSE_HEADER } from '../src/lib/tunnel';

const silent = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    silly() {},
    level: 'info',
} as unknown as ioBroker.Logger;

/** Sends one HTTP request through the tunnel, as the server does for the browser */
function requestThrough(mux: Mux, path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = http.request({ path, headers: { host: 'x' }, createConnection: () => mux.open() as never }, res => {
            let body = '';
            res.on('data', c => (body += c));
            res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('remote access tunnel of the agent', () => {
    let local: http.Server;
    let localPort: number;
    let server: http.Server;
    let wss: WebSocketServer;
    let url: string;
    /** connections of the stand-in for the beekeeper server */
    const events: { headers: http.IncomingHttpHeaders; ws?: WebSocket; mux?: Mux }[] = [];
    let answer = 101;

    before(async () => {
        local = http.createServer((req, res) => res.end(`local ${req.url}`));
        await new Promise<void>(r => local.listen(0, '127.0.0.1', r));
        localPort = (local.address() as AddressInfo).port;

        wss = new WebSocketServer({ noServer: true });
        server = http.createServer();
        server.on('upgrade', (req, socket, head) => {
            const ev: (typeof events)[number] = { headers: req.headers };
            events.push(ev);
            if (answer !== 101) {
                socket.end(`HTTP/1.1 ${answer} No\r\nContent-Length: 0\r\n\r\n`);
                return;
            }
            wss.handleUpgrade(req, socket, head, ws => {
                ev.ws = ws;
                ev.mux = new Mux(frame => ws.send(frame));
                ws.on('message', data => ev.mux!.receive(data as Buffer));
            });
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/tunnel`;
    });

    after(async () => {
        wss.clients.forEach(c => c.terminate());
        await new Promise(r => server.close(r));
        await new Promise(r => local.close(r));
    });

    const request = (extra: Partial<TunnelRequest> = {}): TunnelRequest => ({
        id: 'acc_1',
        kind: 'admin',
        url,
        ticket: 'secret',
        expiresAt: Date.now() + 60_000,
        by: 'Service (service)',
        purpose: 'Test',
        ...extra,
    });

    const waitFor = async <T>(fn: () => T | undefined, ms = 5000): Promise<T> => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
            const v = fn();
            if (v) {
                return v;
            }
            await new Promise(r => setTimeout(r, 20));
        }
        throw new Error('timeout');
    };

    it('carries streams to the local interface, reconnects, and stops when the server ends', async () => {
        answer = 101;
        events.length = 0;
        const ended: string[] = [];
        const client = new TunnelClient(request(), {
            target: { host: '127.0.0.1', port: localPort, secure: false, instance: 'admin.0' },
            refusal: null,
            ca: [],
            log: silent,
            onEnd: (_c, reason) => ended.push(reason),
        });
        client.start();
        const first = await waitFor(() => events[0]?.mux && events[0]);
        assert.equal(first.headers.authorization, 'Bearer secret');
        assert.equal(await requestThrough(first.mux!, '/a'), 'local /a');

        // connection lost (e.g. LTE): the agent comes back by itself
        first.ws!.terminate();
        const second = await waitFor(() => events[1]?.mux && events[1], 8000);
        assert.equal(await requestThrough(second.mux!, '/b'), 'local /b');

        second.ws!.close(CLOSE.ENDED, 'ended');
        await waitFor(() => ended[0]);
        assert.equal(ended[0], 'ended by the server');
        await new Promise(r => setTimeout(r, 300));
        assert.equal(events.length, 2, 'no reconnect after a regular end');
    });

    it('sends a refusal instead of opening the tunnel', async () => {
        answer = 403;
        events.length = 0;
        const ended: string[] = [];
        const client = new TunnelClient(request({ id: 'acc_2' }), {
            target: null,
            refusal: 'Fernzugriff auf admin ist am Gerät abgeschaltet',
            ca: [],
            log: silent,
            onEnd: (_c, reason) => ended.push(reason),
        });
        client.start();
        await waitFor(() => ended[0]);
        assert.equal(ended[0], 'refused');
        assert.equal(
            decodeURIComponent(String(events[0].headers[REFUSE_HEADER])),
            'Fernzugriff auf admin ist am Gerät abgeschaltet',
        );
    });

    it('gives up on an ended session (HTTP 410)', async () => {
        answer = 410;
        events.length = 0;
        const ended: string[] = [];
        new TunnelClient(request({ id: 'acc_3' }), {
            target: { host: '127.0.0.1', port: localPort, secure: false, instance: 'admin.0' },
            refusal: null,
            ca: [],
            log: silent,
            onEnd: (_c, reason) => ended.push(reason),
        }).start();
        await waitFor(() => ended[0]);
        assert.match(ended[0], /410/);
        await new Promise(r => setTimeout(r, 300));
        assert.equal(events.length, 1);
    });

    it('connects only to its own server', () => {
        const servers = ['https://bee.example.com', 'mqtts://bee.example.com:8883'];
        assert.equal(trustedTunnelUrl('wss://bee.example.com/tunnel', servers), true);
        assert.equal(trustedTunnelUrl('wss://evil.example.com/tunnel', servers), false);
        assert.equal(
            trustedTunnelUrl('ws://bee.example.com/tunnel', servers),
            false,
            'no plain text over the internet',
        );
        assert.equal(trustedTunnelUrl('ws://localhost:8091/tunnel', ['http://localhost:8091']), true);
        assert.equal(trustedTunnelUrl('not a url', servers), false);
    });

    it('finds the local interface of admin and web', async () => {
        const rows = [
            { value: { _id: 'system.adapter.admin.1', common: { enabled: true, host: 'h' }, native: { port: 9000 } } },
            {
                value: {
                    _id: 'system.adapter.admin.0',
                    common: { enabled: true, host: 'h' },
                    native: { port: 8081, bind: '0.0.0.0', secure: true },
                },
            },
            { value: { _id: 'system.adapter.web.0', common: { enabled: false, host: 'h' }, native: { port: 8082 } } },
        ];
        const adapter = {
            host: 'h',
            getObjectViewAsync: async (_d: string, _v: string, p: { startkey: string }) => ({
                rows: rows.filter(r => r.value._id.startsWith(p.startkey)),
            }),
        } as unknown as ioBroker.Adapter;
        assert.deepEqual(await findTarget(adapter, 'admin'), {
            host: '127.0.0.1',
            port: 8081,
            secure: true,
            instance: 'admin.0',
        });
        assert.equal(await findTarget(adapter, 'vis'), null, 'disabled web instance');
    });
});
