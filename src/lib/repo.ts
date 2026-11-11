import type { RepoInfo } from './protocol';

/**
 * The adapter repositories set in admin, for the updates of the installed adapters in the fleet management.
 * js-controller keeps them in system.repositories (several megabytes), so the agent reads them only on start
 * and when admin loads them again, and keeps the versions of all adapters in memory.
 */
export interface RepoCatalog {
    active: RepoInfo['active'];
    /** Version of every adapter in the active repositories */
    versions: Record<string, string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A link without user, password, query and fragment: a private repository may carry its key there
 *
 * @param link URL or path of the repository
 */
export function safeLink(link: string): string {
    try {
        const url = new URL(link);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        // a path of a file
        return link.replace(/[?#].*$/, '');
    }
}

/**
 * The catalog of the active repositories; undefined if no repository is active
 *
 * @param activeRepo common.activeRepo of system.config: a name or a list of names
 * @param repositories native.repositories of system.repositories: per name the link, and the content once loaded
 */
export function repoCatalog(activeRepo: unknown, repositories: unknown): RepoCatalog | undefined {
    const names = (Array.isArray(activeRepo) ? activeRepo : [activeRepo]).filter(
        (n): n is string => typeof n === 'string' && !!n,
    );
    if (!names.length) {
        return undefined;
    }
    const repos = isObject(repositories) ? repositories : {};
    const active: RepoCatalog['active'] = [];
    const versions: Record<string, string> = {};
    for (const name of names) {
        const repo = repos[name];
        // older js-controller: only the link
        const link = typeof repo === 'string' ? repo : isObject(repo) && typeof repo.link === 'string' ? repo.link : '';
        const time =
            isObject(repo) && (typeof repo.time === 'string' || typeof repo.time === 'number')
                ? new Date(repo.time).getTime()
                : NaN;
        active.push({ name, link: safeLink(link), time: Number.isFinite(time) ? time : null });
        // as js-controller merges them: a later repository wins
        if (isObject(repo) && isObject(repo.json)) {
            for (const [adapter, entry] of Object.entries(repo.json)) {
                if (isObject(entry) && typeof entry.version === 'string' && entry.version) {
                    versions[adapter] = entry.version;
                }
            }
        }
    }
    return { active, versions };
}

/**
 * The versions of the installed adapters and of js-controller in the catalog, for the inventory
 *
 * @param catalog the catalog of the active repositories
 * @param installed names of the installed adapters
 */
export function repoInfo(catalog: RepoCatalog | undefined, installed: string[]): RepoInfo | undefined {
    if (!catalog) {
        return undefined;
    }
    const versions: Record<string, string> = {};
    for (const name of [...installed, 'js-controller'].sort()) {
        if (Object.hasOwn(catalog.versions, name)) {
            versions[name] = catalog.versions[name];
        }
    }
    return { active: catalog.active, versions };
}
