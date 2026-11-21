import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * OS updates of the own host with apt-get, the way bee-linux does them.
 *
 * The host command of js-controller (upgradeOsPackages) runs `apt upgrade -y <name>` for each package. That has three
 * flaws: there is no `apt update` before, so a package list a few days old asks the Debian mirror for versions it has
 * deleted meanwhile (404, "Unable to fetch some archives"); `apt upgrade <name>` upgrades every package, not only the
 * chosen one; and a changed configuration file makes dpkg wait for an answer that nobody gives. The agent therefore
 * refreshes the lists first and then installs only the chosen packages, without questions. On another host of the
 * system it cannot run anything, there js-controller stays in charge.
 */

/** Waits up to 5 minutes for another apt, e.g. the automatic updates, instead of failing on its lock */
const LOCK = ['-o', 'DPkg::Lock::Timeout=300'];

/** apt-get without questions: dpkg keeps changed configuration files and takes the default of the package otherwise */
const NO_QUESTIONS = ['-y', '-q', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];

/**
 * No dialog, no pager with the changes of a package, needrestart only lists. sudo drops these (env_reset); the
 * options above and the closed input then keep apt from asking.
 */
const ENV = { DEBIAN_FRONTEND: 'noninteractive', APT_LISTCHANGES_FRONTEND: 'none', NEEDRESTART_MODE: 'l' };

export function aptUpdateArgs(): string[] {
    return ['apt-get', '-q', ...LOCK, 'update'];
}

/**
 * Upgrade of exactly these packages, plus what they need; nothing else is touched
 *
 * @param names packages as js-controller lists them
 */
export function aptUpgradeArgs(names: string[]): string[] {
    return ['apt-get', ...NO_QUESTIONS, ...LOCK, 'install', '--only-upgrade', ...names];
}

/** A system with apt; with yum js-controller stays in charge */
export function hasAptGet(): boolean {
    return existsSync('/usr/bin/apt-get');
}

export interface AptRun {
    ok: boolean;
    /** stdout and stderr */
    output: string;
    /** sudo does not allow apt-get here */
    denied: boolean;
}

/** sudo refused the command, as opposed to apt failing */
export function sudoDenied(stderr: string): boolean {
    return /^sudo: /m.test(stderr) && /password is required|not allowed|may not run|not in the sudoers/i.test(stderr);
}

/**
 * Runs apt-get as root: directly as root, else with sudo -n (the installer of ioBroker allows apt-get to the user
 * iobroker without a password)
 *
 * @param args the command, e.g. aptUpgradeArgs(names)
 * @param timeout longest run
 */
export function runApt(args: string[], timeout: number): Promise<AptRun> {
    const root = process.getuid?.() === 0;
    const [cmd, list] = root ? [args[0], args.slice(1)] : ['sudo', ['-n', ...args]];
    return new Promise(resolve => {
        const child = execFile(
            cmd,
            list,
            { timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...ENV }, windowsHide: true },
            (error, stdout, stderr) => {
                const output = `${String(stdout)}\n${String(stderr)}`.trim();
                resolve({
                    ok: !error,
                    output: output || error?.message || '',
                    denied: !root && !!error && sudoDenied(String(stderr)),
                });
            },
        );
        // nobody is there to answer: whatever still asks reads the end of the input instead of waiting for ever
        child.stdin?.end();
    });
}

/** Names of the packages whose files the mirror no longer has (404) */
function missingPackages(output: string): string[] {
    const names = new Set<string>();
    for (const m of output.matchAll(/\/([^/\s]+?)_[^/\s]+\.deb\s+404\b/g)) {
        names.add(m[1]);
    }
    return [...names];
}

/**
 * What went wrong, in a few lines, with what to do about it: the errors of apt and dpkg without the rest of the
 * output, and a hint for the usual causes
 *
 * @param output what apt printed, or the error of js-controller with it
 * @param remoteHost the host when js-controller ran apt on another host of the system
 */
export function aptFailure(output: string, remoteHost?: string): string {
    const on = remoteHost ? ` auf ${remoteHost}` : '';
    if (/\b404\s+Not Found\b|Unable to fetch some archives/i.test(output)) {
        const missing = missingPackages(output);
        const list = missing.length
            ? ` (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` und ${missing.length - 6} weitere` : ''})`
            : '';
        return remoteHost
            ? `Die Paketlisten${on} sind veraltet: apt wollte Versionen laden, die der Debian-Spiegel nicht mehr hat${list}. Auf ${remoteHost} einmal "sudo apt update" ausführen, dann erneut einspielen; dort spielt js-controller die Pakete ein, ohne die Listen vorher zu aktualisieren.`
            : `Der Debian-Spiegel hat Pakete nicht, obwohl die Paketlisten gerade aktualisiert wurden${list}. Meist ist der Spiegel mitten in einer Aktualisierung; in einer Stunde erneut einspielen.`;
    }
    if (/Could not get lock|Unable to acquire the dpkg frontend lock/i.test(output)) {
        return `apt läuft${on} gerade schon (etwa die automatischen Updates). Später erneut einspielen.`;
    }
    if (/dpkg was interrupted/i.test(output)) {
        return `Eine frühere Installation${on} wurde unterbrochen. Einmal "sudo dpkg --configure -a" ausführen (Konsole), dann erneut einspielen.`;
    }
    const lines = output
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !/^WARNING: apt does not have a stable CLI/.test(l));
    const errors = lines.filter(l => /^(E:|Err:|dpkg:|Command failed:|sudo:)/.test(l));
    const shown = (errors.length ? errors : lines.slice(-8))
        .slice(0, 8)
        .map(l => (l.length > 300 ? `${l.slice(0, 300)} …` : l));
    return shown.join('\n') || 'apt meldet einen Fehler';
}
