/**
 * Whether an instance runs. Most instances have a process of their own and report it in
 * system.adapter.<id>.alive. An adapter with a web extension that is set to run inside a web instance
 * (common.webExtension and native.webInstance, the rule of admin) has no process of its own: its alive
 * stays false while it runs inside web. It runs when its web instance runs ("*": any of them) and it does
 * not report the opposite in its state info.extension.
 */

type StateReader = (id: string) => Promise<ioBroker.State | null | undefined>;

/**
 * The web instance an instance runs in as a web extension, e.g. "web.0", "*" for every web instance;
 * undefined if it has a process of its own.
 *
 * @param obj the object system.adapter.<id>
 */
export function webExtensionOf(obj: ioBroker.InstanceObject): string | undefined {
    const web = (obj.native as Record<string, unknown> | undefined)?.webInstance;
    if (
        obj.common.mode !== 'daemon' ||
        !obj.common.enabled ||
        !obj.common.webExtension ||
        typeof web !== 'string' ||
        !web
    ) {
        return undefined;
    }
    return web.replace(/^system\.adapter\./, '');
}

/**
 * Whether an instance runs, also as a web extension.
 *
 * @param obj the object system.adapter.<id>
 * @param readState reads a foreign state
 * @param webInstances the enabled web instances, e.g. ["web.0"]; only asked for "*"
 */
export async function instanceRunning(
    obj: ioBroker.InstanceObject,
    readState: StateReader,
    webInstances: () => Promise<string[]>,
): Promise<boolean> {
    const web = webExtensionOf(obj);
    if (!web) {
        return !!(await readState(`${obj._id}.alive`))?.val;
    }
    const id = obj._id.replace(/^system\.adapter\./, '');
    if ((await readState(`${id}.info.extension`))?.val === false) {
        return false;
    }
    for (const w of web === '*' ? await webInstances() : [web]) {
        if ((await readState(`system.adapter.${w}.alive`))?.val) {
            return true;
        }
    }
    return false;
}

/**
 * An adapter that only brings files for web (common.onlyWWW, e.g. material): js-controller starts no
 * process for it, except for the old vis.
 *
 * @param obj the object system.adapter.<id>
 */
export function onlyWww(obj: ioBroker.InstanceObject): boolean {
    return !!obj.common.onlyWWW && obj.common.name !== 'vis';
}

/** "web.0", or "web" for every web instance */
export function webText(web: string): string {
    return web === '*' ? 'web' : web;
}
