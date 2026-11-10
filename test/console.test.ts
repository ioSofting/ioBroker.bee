import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { findScript, loginShell, parentOf, startShell } from '../src/lib/console';
import { CONSOLE, ConsoleReader, consoleMessage, Mux, resizeMessage, type TunnelStream } from '../src/lib/tunnel';

const silent = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    silly() {},
    level: 'info',
} as unknown as ioBroker.Logger;

const waitFor = async (fn: () => boolean, what: string, ms = 10_000): Promise<void> => {
    const until = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > until) {
            throw new Error(`timeout waiting for ${what}`);
        }
        await new Promise(r => setTimeout(r, 50));
    }
};

/** Server and agent side of a tunnel in memory; every stream the server opens is a shell on the agent side */
function shellThroughTunnel(onEnd: (result: string) => void): {
    stream: TunnelStream;
    output: () => string;
    exit: Promise<string>;
} {
    let server: Mux | null = null;
    const agent = new Mux(
        frame => setImmediate(() => server!.receive(frame)),
        s => startShell(s, { cwd: tmpdir(), log: silent, by: 'test', onEnd }),
    );
    server = new Mux(
        frame => setImmediate(() => agent.receive(frame)),
        () => {},
    );
    const stream = server.open();
    let text = '';
    const exit = new Promise<string>(resolve => {
        const reader = new ConsoleReader((type, payload) => {
            if (type === CONSOLE.DATA) {
                text += payload.toString('utf8');
            } else if (type === CONSOLE.EXIT) {
                resolve(payload.toString('utf8'));
            }
        });
        stream.on('data', (chunk: Buffer) => reader.push(chunk));
    });
    return { stream, output: () => text, exit };
}

const type = (stream: TunnelStream, text: string): void => {
    stream.write(consoleMessage(CONSOLE.DATA, Buffer.from(text)));
};

const noScript = !findScript() && 'needs Linux with script (util-linux)';

describe('console', () => {
    it('reads the parent from /proc/<pid>/stat, also with odd process names', () => {
        assert.equal(parentOf('123 (bash) S 77 123 123 34816 123 4194560'), 77);
        assert.equal(parentOf('9 (a) b) (c) R 42 9 9 0'), 42);
    });

    it('never takes a nologin shell', () => {
        const shell = loginShell({ SHELL: '/usr/sbin/nologin' });
        assert.ok(!shell.endsWith('nologin'), shell);
    });

    it(
        'runs a shell with the size of the window, and passes its exit code',
        { skip: noScript, timeout: 30_000 },
        async () => {
            const { stream, output, exit } = shellThroughTunnel(() => {});
            stream.write(resizeMessage(100, 30));
            type(stream, 'echo ready-$((40+2))\n');
            await waitFor(() => output().includes('ready-42'), 'the shell');
            // the size reaches the terminal of the shell a moment after it started
            await waitFor(() => {
                if (output().includes('30 100')) {
                    return true;
                }
                type(stream, 'stty size\n');
                return false;
            }, 'size of the window');
            type(stream, 'exit 3\n');
            assert.equal(await exit, '3');
        },
    );

    it('hangs up the shell when the stream ends', { skip: noScript, timeout: 30_000 }, async () => {
        let ended: string | null = null;
        const { stream, output } = shellThroughTunnel(result => (ended = result));
        type(stream, 'echo ready-$((40+2))\n');
        await waitFor(() => output().includes('ready-42'), 'the shell');
        stream.destroy();
        await waitFor(() => ended !== null, 'end of the shell', 6000);
    });

    it(
        'also ends a shell that is still writing when the stream goes',
        { skip: noScript, timeout: 30_000 },
        async () => {
            let ended: string | null = null;
            const { stream, output } = shellThroughTunnel(result => (ended = result));
            // output keeps coming after the stream is gone; the agent must not wait for a drain then
            type(stream, 'yes flood\n');
            await waitFor(() => output().length > 100_000, 'output of the shell');
            stream.destroy();
            await waitFor(() => ended !== null, 'end of the shell', 8000);
        },
    );
});
