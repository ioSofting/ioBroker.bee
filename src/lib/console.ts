import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import os from 'node:os';
import type { Duplex } from 'node:stream';
import { CONSOLE, ConsoleReader, consoleMessage } from './tunnel';

/**
 * Console of the remote access: a shell on this system for one terminal in the browser of the technician.
 * Each stream of the tunnel is one shell. No native module: `script` of util-linux (on every Debian) gives the
 * shell a pseudo terminal, and `stty` sets the size of its window. Only Linux, and only when the owner allows it.
 */

/** Shells per access session at the same time */
export const MAX_SHELLS = 4;

/** `script` of util-linux, null if this system has none (then there is no console) */
export function findScript(): string | null {
    if (process.platform !== 'linux') {
        return null;
    }
    return ['/usr/bin/script', '/bin/script'].find(p => existsSync(p)) ?? null;
}

function findStty(): string {
    return ['/usr/bin/stty', '/bin/stty'].find(p => existsSync(p)) ?? 'stty';
}

/** A shell to log in with; the one of a service user is often nologin, so not taken from /etc/passwd */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
    return (
        [env.SHELL, '/bin/bash', '/bin/sh'].find(s => !!s && !/(nologin|false)$/.test(s) && existsSync(s)) ?? '/bin/sh'
    );
}

/** The user the shell runs as: the user of ioBroker */
export function consoleUser(): string {
    try {
        return os.userInfo().username;
    } catch {
        return String(process.getuid?.() ?? '');
    }
}

/** Parent process id from /proc/<pid>/stat; the name in parentheses may contain spaces and parentheses */
export function parentOf(stat: string): number {
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return parseInt(rest[1], 10);
}

/** The child of `script` (the shell) and the terminal it reads from, e.g. /dev/pts/3 */
function findTerminal(scriptPid: number): { pid: number; tty: string } | null {
    for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) {
            continue;
        }
        try {
            if (parentOf(readFileSync(`/proc/${entry}/stat`, 'utf8')) === scriptPid) {
                const tty = readlinkSync(`/proc/${entry}/fd/0`);
                if (tty.startsWith('/dev/pts/')) {
                    return { pid: parseInt(entry, 10), tty };
                }
            }
        } catch {
            // the process ended meanwhile, or is not ours
        }
    }
    return null;
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
    if (!pid) {
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        // already gone
    }
}

export interface ShellOptions {
    /** Working directory, the ioBroker directory */
    cwd: string;
    log: ioBroker.Logger;
    /** Who opened it, for the log */
    by: string;
    onEnd?: (result: string) => void;
}

/**
 * Runs one shell for a stream of the tunnel until one of both ends.
 *
 * @param stream stream of the tunnel, carrying console messages (see tunnel.ts)
 * @param opts working directory, logger and who opened it
 */
export function startShell(stream: Duplex, opts: ShellOptions): void {
    const script = findScript();
    if (!script) {
        stream.end(consoleMessage(CONSOLE.EXIT, Buffer.from('keine Konsole auf diesem System')));
        return;
    }
    const shell = loginShell();
    const home = (() => {
        try {
            return os.userInfo().homedir;
        } catch {
            return opts.cwd;
        }
    })();
    // a fresh login environment instead of the one of the adapter process
    const env: NodeJS.ProcessEnv = {
        HOME: home,
        USER: consoleUser(),
        LOGNAME: consoleUser(),
        SHELL: shell,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        LANG: process.env.LANG || 'C.UTF-8',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
    };
    // detached: own process group, so that the end reaches everything started in it
    const child: ChildProcess = spawn(script, ['-qfec', `exec ${shell} -l`, '/dev/null'], {
        cwd: existsSync(opts.cwd) ? opts.cwd : home,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let terminal: { pid: number; tty: string } | null = null;
    let size: { cols: number; rows: number } | null = null;
    let ended = false;
    let killTimer: NodeJS.Timeout | null = null;

    const applySize = (): void => {
        if (terminal && size) {
            // the kernel tells the shell (SIGWINCH)
            execFile(findStty(), ['-F', terminal.tty, 'cols', String(size.cols), 'rows', String(size.rows)], err => {
                if (err) {
                    opts.log.debug(`Console: stty: ${err.message}`);
                }
            });
        }
    };
    // the shell needs a moment until it runs on its terminal
    let tries = 0;
    const lookup = setInterval(() => {
        if (ended || terminal || ++tries > 60 || !child.pid) {
            clearInterval(lookup);
            return;
        }
        terminal = findTerminal(child.pid);
        if (terminal) {
            clearInterval(lookup);
            applySize();
        }
    }, 50);

    const stop = (): void => {
        if (killTimer || ended) {
            return;
        }
        // hang up: the shell and what runs in its foreground get SIGHUP, as when an SSH connection drops
        signalGroup(terminal?.pid, 'SIGHUP');
        signalGroup(child.pid, 'SIGHUP');
        killTimer = setTimeout(() => {
            signalGroup(terminal?.pid, 'SIGKILL');
            signalGroup(child.pid, 'SIGKILL');
        }, 3000);
    };

    const forward = (chunk: Buffer): void => {
        if (!stream.write(consoleMessage(CONSOLE.DATA, chunk))) {
            // the browser is slow: hold the shell back
            child.stdout?.pause();
            child.stderr?.pause();
            stream.once('drain', () => {
                child.stdout?.resume();
                child.stderr?.resume();
            });
        }
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.stdin?.on('error', () => {});

    const reader = new ConsoleReader((type, payload) => {
        if (type === CONSOLE.DATA) {
            child.stdin?.write(payload);
        } else if (type === CONSOLE.RESIZE && payload.length >= 4) {
            const clamp = (n: number): number => Math.max(1, Math.min(1000, n));
            size = { cols: clamp(payload.readUInt16BE(0)), rows: clamp(payload.readUInt16BE(2)) };
            applySize();
        }
    });
    stream.on('data', (chunk: Buffer) => {
        if (!reader.push(chunk)) {
            stream.destroy(new Error('invalid console message'));
        }
    });
    stream.on('end', stop);
    stream.on('close', stop);
    stream.on('error', stop);

    child.on('error', err => {
        opts.log.warn(`Console: ${err.message}`);
        stop();
    });
    child.on('close', (code, signal) => {
        ended = true;
        clearInterval(lookup);
        if (killTimer) {
            clearTimeout(killTimer);
        }
        const result = signal ? signal : String(code ?? '');
        if (!stream.destroyed && stream.writable) {
            stream.end(consoleMessage(CONSOLE.EXIT, Buffer.from(result)));
        }
        opts.log.info(`Console of ${opts.by} ended (${result})`);
        opts.onEnd?.(result);
    });
    opts.log.info(`Console: shell ${shell} as ${consoleUser()} started for ${opts.by}`);
}
