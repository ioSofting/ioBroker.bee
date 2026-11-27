import { MAX_MCP_RESULT, type AiAccess, type McpReply, type McpRequest, type McpTool } from './protocol';
import { compareVersions, type Timers } from './util';

/**
 * AI access of the fleet management (command 'mcp'). An AI of the integrator works with the MCP server of ioBroker
 * (package `@iobroker/mcp-server`), which the agent runs in its own process, only:
 * - if the owner allows it in the instance (off by default), with the rights set there (reading by default),
 * - while a person opened an AI session in the fleet management: each request carries the session with its end,
 *   so the agent knows it after its own restart as well, and refuses it after the end.
 * The MCP server starts with the first request and stops when the last session ended.
 */

/** `@iobroker/mcp-server` needs this Node.js */
export const AI_MIN_NODE = '22.19.0';
/** Without a request for this long after the last session the MCP server stops */
const CHECK_MS = 30_000;

export interface AiSettings {
    allowAi: boolean;
    aiSetState: boolean;
    aiObjectChange: boolean;
    /** ioBroker user, "admin" or "system.user.admin" */
    aiUser: string;
}

/** An AI session as the device knows it */
export interface AiSessionInfo {
    id: string;
    by: string;
    purpose: string;
    expiresAt: number;
    calls: number;
}

/** What the agent needs of the facade of `@iobroker/mcp-server` (createInProcessMcp) */
export interface McpClient {
    listTools(): Promise<McpTool[]>;
    callTool(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
    close(): Promise<void>;
}

/**
 * The ioBroker user as the MCP server takes it; undefined for an invalid name
 *
 * @param user "admin" or "system.user.admin"
 */
export function aiUserId(user: string | undefined): `system.user.${string}` | undefined {
    const name = (user || 'admin').trim().replace(/^system\.user\./, '');
    return /^[\w.-]{1,64}$/.test(name) ? `system.user.${name}` : undefined;
}

/**
 * What the agent reports (Inventory.ai); undefined while the owner does not allow it. error: only what stays until
 * the owner changes something; a failed start of the MCP server is the answer to the request (it may work next time)
 *
 * @param settings instance settings
 * @param nodeVersion the running Node.js, e.g. "22.20.0"
 */
export function aiAccess(settings: AiSettings, nodeVersion: string): AiAccess | undefined {
    if (settings.allowAi !== true) {
        return undefined;
    }
    const user = aiUserId(settings.aiUser);
    const error =
        compareVersions(nodeVersion, AI_MIN_NODE) < 0
            ? `Node.js ab ${AI_MIN_NODE} nötig, auf dem Gerät läuft ${nodeVersion}`
            : !user
              ? `Ungültiger ioBroker-Nutzer "${settings.aiUser}"`
              : undefined;
    return {
        user: user?.replace(/^system\.user\./, '') ?? String(settings.aiUser),
        setState: settings.aiSetState === true,
        objectChange: settings.aiObjectChange === true,
        ...(error ? { error } : {}),
    };
}

/**
 * The text of a tool for the answer: at most MAX_MCP_RESULT characters
 *
 * @param result the result of the tool
 * @param result.text its text
 * @param result.isError whether the tool failed
 */
export function cutResult(result: { text: string; isError: boolean }): NonNullable<McpReply['result']> {
    const text = typeof result?.text === 'string' ? result.text : '';
    return text.length > MAX_MCP_RESULT
        ? { text: text.slice(0, MAX_MCP_RESULT), isError: !!result.isError, truncated: true }
        : { text, isError: !!result?.isError };
}

/** Only the parts of a tool the server needs */
function toolOf(t: McpTool): McpTool {
    return {
        name: t.name,
        ...(t.title ? { title: t.title } : {}),
        ...(t.description ? { description: t.description } : {}),
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' },
        ...(t.annotations ? { annotations: t.annotations } : {}),
    };
}

export class AiAccessManager {
    private readonly sessions = new Map<string, AiSessionInfo>();
    private client: McpClient | null = null;
    private starting: Promise<McpClient> | null = null;
    private readonly timer: ioBroker.Interval | undefined;
    /** Why the MCP server could not be started the last time */
    loadError: string | undefined;

    constructor(
        private readonly opts: {
            settings: AiSettings;
            nodeVersion: string;
            /** starts the MCP server of ioBroker with these settings */
            create: (settings: AiSettings) => Promise<McpClient>;
            log: { info: (msg: string) => void; warn: (msg: string) => void; debug: (msg: string) => void };
            /** the open sessions changed (states for the owner) */
            onChange: () => void;
            timers: Timers;
            now?: () => number;
        },
    ) {
        this.timer = opts.timers.setInterval(() => void this.expire(), CHECK_MS);
    }

    private now(): number {
        return this.opts.now ? this.opts.now() : Date.now();
    }

    /** The open sessions, for the states of the owner */
    list(): AiSessionInfo[] {
        return [...this.sessions.values()].filter(s => s.expiresAt > this.now());
    }

    /** Ends expired sessions; stops the MCP server when none is left */
    async expire(): Promise<void> {
        let changed = false;
        for (const s of [...this.sessions.values()]) {
            if (s.expiresAt <= this.now()) {
                this.sessions.delete(s.id);
                this.opts.log.info(`AI access of ${s.by} ended (${s.calls} calls)`);
                changed = true;
            }
        }
        if (changed) {
            this.opts.onChange();
        }
        if (!this.sessions.size) {
            await this.stopClient();
        }
    }

    private async mcp(): Promise<McpClient> {
        if (this.client) {
            return this.client;
        }
        this.starting ??= this.opts
            .create(this.opts.settings)
            .then(client => {
                this.client = client;
                this.loadError = undefined;
                return client;
            })
            .catch((e: Error) => {
                this.loadError = `MCP-Server startet nicht: ${e.message}`;
                throw new Error(this.loadError);
            })
            .finally(() => {
                this.starting = null;
            });
        return this.starting;
    }

    private async stopClient(): Promise<void> {
        const client = this.client;
        this.client = null;
        if (client) {
            try {
                await client.close();
            } catch (e) {
                this.opts.log.debug(`MCP server not closed: ${e.message}`);
            }
        }
    }

    /**
     * A request of the AI; throws with the reason (German, for the fleet management) when it is refused
     *
     * @param req the request
     */
    async handle(req: McpRequest | undefined): Promise<McpReply> {
        if (!req || typeof req.session !== 'string' || !req.session || typeof req.expiresAt !== 'number') {
            throw new Error('Unvollständige Anfrage');
        }
        if (req.action === 'close') {
            const s = this.sessions.get(req.session);
            if (s) {
                this.sessions.delete(req.session);
                this.opts.log.info(`AI access of ${s.by} ended by the fleet management (${s.calls} calls)`);
                this.opts.onChange();
                if (!this.sessions.size) {
                    await this.stopClient();
                }
            }
            return {};
        }
        const access = aiAccess(this.opts.settings, this.opts.nodeVersion);
        if (!access) {
            throw new Error('Der KI-Zugang ist auf diesem Gerät nicht erlaubt (Instanz bee, Tab Fernzugriff)');
        }
        if (access.error) {
            throw new Error(access.error);
        }
        if (req.expiresAt <= this.now()) {
            if (this.sessions.delete(req.session)) {
                this.opts.onChange();
            }
            throw new Error('Der KI-Zugang ist abgelaufen');
        }
        let s = this.sessions.get(req.session);
        if (!s) {
            s = {
                id: req.session,
                by: String(req.by || 'Flottenverwaltung').slice(0, 200),
                purpose: String(req.purpose || '').slice(0, 300),
                expiresAt: req.expiresAt,
                calls: 0,
            };
            this.sessions.set(s.id, s);
            this.opts.log.info(
                `AI access opened by ${s.by}: ${s.purpose} (until ${new Date(s.expiresAt).toLocaleTimeString()})`,
            );
            this.opts.onChange();
        }
        // the server decides the end
        s.expiresAt = req.expiresAt;
        if (req.action === 'open' || req.action === 'tools') {
            const client = await this.mcp();
            return { tools: (await client.listTools()).map(toolOf) };
        }
        if (req.action !== 'call') {
            throw new Error(`Unbekannte Aktion ${String(req.action)}`);
        }
        if (typeof req.tool !== 'string' || !req.tool || req.tool.length > 100) {
            throw new Error('Name des Werkzeugs fehlt');
        }
        const args = req.args && typeof req.args === 'object' && !Array.isArray(req.args) ? req.args : {};
        const client = await this.mcp();
        s.calls++;
        this.opts.log.debug(`AI tool ${req.tool} for ${s.by}`);
        return { result: cutResult(await client.callTool(req.tool, args)) };
    }

    async stop(): Promise<void> {
        this.opts.timers.clearInterval(this.timer);
        this.sessions.clear();
        await this.stopClient();
    }
}
