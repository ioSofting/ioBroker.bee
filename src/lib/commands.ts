import {
    INSTANCE_ID,
    parseOsPackage,
    type AgentCommand,
    type InstanceAction,
    type OsPackage,
    type OsUpdates,
} from './protocol';
import { onlyWww, webExtensionOf, webText } from './instances';
import { compareVersions } from './util';

/**
 * Commands of the fleet management to this system: start, stop or restart an instance (as admin does it,
 * through the instance object), restart ioBroker, upgrade packages of the operating system. The last two
 * are done by js-controller (host commands restartController and upgradeOsPackages); the agent only passes
 * them on, and only packages js-controller listed itself as upgradeable.
 */

/** Exists on Debian and Ubuntu when an update asks for a reboot of the system */
export const REBOOT_REQUIRED = '/var/run/reboot-required';

/** Longest wait for js-controller to load the repositories again (it downloads several megabytes) */
export const REPO_TIMEOUT = 120_000;

/**
 * What this system can do: OS updates need Linux and js-controller 6 (it lists them and runs apt);
 * controller: js-controller upgrades itself (Linux, js-controller 5); logs: list and upload log files;
 * adapter: install a version; software: remove an adapter, add or delete an instance; mcp: AI access (whether
 * the owner allows it is Inventory.ai)
 */
export function supportedCommands(jsController: string, platform: string = process.platform): AgentCommand[] {
    const commands: AgentCommand[] = ['instance', 'restart'];
    if (platform === 'linux' && jsController && compareVersions(jsController, '6.0.0') >= 0) {
        commands.push('osUpgrade');
    }
    if (controllerUpgradable(jsController, platform)) {
        commands.push('controller');
    }
    commands.push('logs', 'adapter', 'software', 'mcp');
    return commands;
}

/**
 * Whether js-controller can upgrade itself on request (host command upgradeController, since js-controller 5): its
 * upgrade manager runs `iobroker stop`, npm in /opt/iobroker and `iobroker start`, so only on Linux. In a Docker
 * container without the official image js-controller refuses it itself.
 *
 * @param jsController installed version
 * @param platform process.platform of the host
 */
export function controllerUpgradable(jsController: string, platform: string): boolean {
    return platform === 'linux' && !!jsController && compareVersions(jsController, '5.0.0') >= 0;
}

/** A version of js-controller as npm knows it, e.g. 7.0.7 or 7.1.0-alpha.3 */
const CONTROLLER_VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

/**
 * Why an upgrade of js-controller is refused; null if it may run
 *
 * @param req the request of the server
 * @param installed the installed version
 * @param platform process.platform of the host
 */
export function controllerRefusal(
    req: { version?: unknown } | undefined,
    installed: string,
    platform: string,
): string | null {
    if (!controllerUpgradable(installed, platform)) {
        return 'js-controller aktualisiert sich nur unter Linux und ab Version 5 selbst';
    }
    const version = req?.version;
    if (typeof version !== 'string' || !CONTROLLER_VERSION.test(version)) {
        return 'Ungültige Version';
    }
    if (compareVersions(version, installed) <= 0) {
        return version === installed
            ? `js-controller ${installed} ist schon installiert`
            : `js-controller ${installed} ist installiert: zurückstufen geht nicht`;
    }
    return null;
}

/**
 * The instance of admin whose port the upgrade manager of js-controller uses for its page with the progress (admin is
 * stopped with ioBroker): an enabled one on the host, else any enabled one, else any one; null without admin
 *
 * @param instances the objects system.adapter.admin.*
 * @param host the host of js-controller
 */
export function chooseAdminInstance(instances: ioBroker.Object[], host: string): number | null {
    const admins = instances.filter(o => o?.type === 'instance' && /^system\.adapter\.admin\.\d+$/.test(o._id));
    const pick =
        admins.find(o => o.common?.enabled && (o.common as ioBroker.InstanceCommon).host === host) ??
        admins.find(o => o.common?.enabled) ??
        admins[0];
    return pick ? Number(pick._id.split('.').pop()) : null;
}

/**
 * OS updates from the state system.host.<host>.osPackageUpdates, which js-controller writes on every update
 * of the repository: a JSON list of lines of `apt list --upgradeable`. Undefined if there is no such state.
 *
 * @param state the state of js-controller
 * @param rebootRequired whether the system asks for a reboot
 */
export function osUpdatesFrom(
    state: ioBroker.State | null | undefined,
    rebootRequired: boolean,
): OsUpdates | undefined {
    if (!state || typeof state.val !== 'string') {
        return undefined;
    }
    let lines: unknown;
    try {
        lines = JSON.parse(state.val);
    } catch {
        return undefined;
    }
    if (!Array.isArray(lines)) {
        return undefined;
    }
    const packages = lines
        .filter((l): l is string => typeof l === 'string')
        .map(parseOsPackage)
        .filter((p): p is OsPackage => !!p);
    return { packages, checkedAt: state.ts || null, rebootRequired };
}

/**
 * Why a command for an instance is not carried out, or null.
 *
 * @param id instance, e.g. "javascript.0"
 * @param action start, stop or restart
 * @param own the instance of the agent itself (bee.0)
 * @param obj the object system.adapter.<id>
 * @param host the host of the agent
 */
export function instanceRefusal(
    id: unknown,
    action: unknown,
    own: string,
    obj: ioBroker.Object | null | undefined,
    host: string,
): string | null {
    if (typeof id !== 'string' || !INSTANCE_ID.test(id)) {
        return `Ungültige Instanz ${String(id)}`;
    }
    if (action !== 'start' && action !== 'stop' && action !== 'restart') {
        return `Unbekannte Aktion ${String(action)}`;
    }
    if (!obj || obj.type !== 'instance') {
        return `Instanz ${id} gibt es auf dem Gerät nicht`;
    }
    if (obj.common.host !== host) {
        return `Instanz ${id} gehört zum Host ${obj.common.host}, nicht zu ${host}`;
    }
    if (onlyWww(obj)) {
        return `${id} hat keinen eigenen Prozess (nur Dateien für web)`;
    }
    if (obj.common.mode === 'none' || obj.common.mode === 'extension') {
        return `${id} hat keinen eigenen Prozess (Modus ${obj.common.mode})`;
    }
    if (id === own && action === 'stop') {
        return 'bee stoppen trennt die Anlage von der Flottenverwaltung; das geht nur am Gerät';
    }
    if (action === 'restart' && !obj.common.enabled) {
        return `Instanz ${id} ist ausgeschaltet; starten statt neu starten`;
    }
    const web = webExtensionOf(obj);
    if (action === 'restart' && web) {
        // web ignores a write of the object that changes nothing
        return `${id} läuft als Erweiterung in ${webText(web)} und hat keinen eigenen Prozess; dafür ${webText(web)} neu starten`;
    }
    return null;
}

export const ACTION_DONE: Record<InstanceAction, string> = {
    start: 'gestartet',
    stop: 'gestoppt',
    restart: 'neu gestartet',
};

/** The packages of a request that js-controller listed, or the names it did not list */
export function chooseOsPackages(listed: OsPackage[], wanted: unknown): { packages: OsPackage[]; unknown: string[] } {
    const names = Array.isArray(wanted) ? wanted.filter((n): n is string => typeof n === 'string') : [];
    return {
        packages: listed.filter(p => names.includes(p.name)),
        unknown: names.filter(n => !listed.some(p => p.name === n)),
    };
}
