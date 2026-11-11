import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aiAccess, AiAccessManager, aiUserId, cutResult, type AiSettings, type McpClient } from '../src/lib/ai';
import { MAX_MCP_RESULT, type McpRequest } from '../src/lib/protocol';

const SETTINGS: AiSettings = { allowAi: true, aiSetState: false, aiObjectChange: false, aiUser: 'admin' };

function manager(settings: Partial<AiSettings> = {}, nodeVersion = '22.20.0') {
    let now = 1_000_000;
    const created: AiSettings[] = [];
    const calls: string[] = [];
    let closed = 0;
    let changes = 0;
    let fail = false;
    const client: McpClient = {
        listTools: async () => [
            {
                name: 'get_states',
                description: 'States',
                inputSchema: { type: 'object' },
                annotations: { readOnlyHint: true },
            },
        ],
        callTool: async (name, args) => {
            calls.push(`${name} ${JSON.stringify(args)}`);
            return name === 'big'
                ? { text: 'x'.repeat(MAX_MCP_RESULT + 10), isError: false }
                : { text: 'ok', isError: false };
        },
        close: async () => void closed++,
    };
    const m = new AiAccessManager({
        settings: { ...SETTINGS, ...settings },
        nodeVersion,
        create: async s => {
            if (fail) {
                throw new Error('Cannot find module');
            }
            created.push(s);
            return client;
        },
        log: { info: () => {}, warn: () => {}, debug: () => {} },
        onChange: () => void changes++,
        now: () => now,
    });
    const req = (action: McpRequest['action'], extra: Partial<McpRequest> = {}): McpRequest => ({
        session: 'ais_1',
        action,
        expiresAt: now + 60_000,
        by: 'Techniker (tech)',
        purpose: 'Supportfall 4711',
        ...extra,
    });
    return {
        m,
        req,
        created,
        calls,
        closed: () => closed,
        changes: () => changes,
        tick: (ms: number) => void (now += ms),
        failStart: () => void (fail = true),
    };
}

describe('AI access', () => {
    it('reports what the owner allows, and why it cannot run', () => {
        assert.equal(aiAccess({ ...SETTINGS, allowAi: false }, '22.20.0'), undefined);
        assert.deepEqual(aiAccess(SETTINGS, '22.20.0'), { user: 'admin', setState: false, objectChange: false });
        assert.deepEqual(aiAccess({ ...SETTINGS, aiSetState: true, aiUser: 'system.user.service' }, '24.1.0'), {
            user: 'service',
            setState: true,
            objectChange: false,
        });
        assert.match(aiAccess(SETTINGS, '20.19.0')!.error!, /Node\.js ab 22\.19\.0/);
        assert.match(aiAccess({ ...SETTINGS, aiUser: 'a b' }, '22.20.0')!.error!, /Ungültiger ioBroker-Nutzer/);
        assert.equal(aiUserId(''), 'system.user.admin');
        assert.equal(aiUserId('../x y'), undefined);
    });

    it('cuts long results', () => {
        const long = cutResult({ text: 'y'.repeat(MAX_MCP_RESULT + 1), isError: true });
        assert.equal(long.text.length, MAX_MCP_RESULT);
        assert.equal(long.truncated, true);
        assert.equal(long.isError, true);
        assert.deepEqual(cutResult({ text: 'ok', isError: false }), { text: 'ok', isError: false });
    });

    it('opens a session, lists and calls tools with the rights of the owner', async () => {
        const t = manager({ aiSetState: true });
        const opened = await t.m.handle(t.req('open'));
        assert.deepEqual(
            opened.tools?.map(x => x.name),
            ['get_states'],
        );
        assert.deepEqual(
            t.m.list().map(s => [s.by, s.purpose]),
            [['Techniker (tech)', 'Supportfall 4711']],
        );
        assert.equal(t.changes(), 1, 'shown to the owner');
        assert.equal(t.created[0].aiSetState, true);
        const res = await t.m.handle(t.req('call', { tool: 'get_states', args: { pattern: 'a.*' } }));
        assert.deepEqual(res.result, { text: 'ok', isError: false });
        assert.deepEqual(t.calls, ['get_states {"pattern":"a.*"}']);
        assert.equal((await t.m.handle(t.req('call', { tool: 'big' }))).result?.truncated, true);
        assert.equal(t.created.length, 1, 'one MCP server for all requests');
        assert.equal(t.m.list()[0].calls, 2);
        await t.m.stop();
    });

    it('knows a session from any request, also after a restart of the agent', async () => {
        const t = manager();
        const res = await t.m.handle(t.req('call', { tool: 'get_states', args: {} }));
        assert.equal(res.result?.text, 'ok');
        assert.equal(t.m.list().length, 1);
        await t.m.stop();
    });

    it('refuses what the owner does not allow, expired sessions and broken requests', async () => {
        await assert.rejects(manager({ allowAi: false }).m.handle(manager().req('open')), /nicht erlaubt/);
        await assert.rejects(manager({}, '20.18.0').m.handle(manager().req('open')), /Node\.js ab 22\.19/);
        const t = manager();
        await assert.rejects(t.m.handle(t.req('open', { expiresAt: 999_000 })), /abgelaufen/);
        await assert.rejects(t.m.handle(undefined), /Unvollständige/);
        await assert.rejects(t.m.handle(t.req('call', { tool: '' })), /Werkzeug/);
        assert.equal(t.calls.length, 0);
        const broken = manager();
        broken.failStart();
        await assert.rejects(broken.m.handle(broken.req('open')), /MCP-Server startet nicht: Cannot find module/);
        assert.match(broken.m.loadError!, /Cannot find module/);
        await t.m.stop();
        await broken.m.stop();
    });

    it('ends sessions on close and when they expire, and stops the MCP server then', async () => {
        const t = manager();
        await t.m.handle(t.req('open'));
        await t.m.handle(t.req('open', { session: 'ais_2', expiresAt: 1_000_000 + 10 * 60_000 }));
        assert.equal(t.m.list().length, 2);
        await t.m.handle(t.req('close'));
        assert.equal(t.m.list().length, 1);
        assert.equal(t.closed(), 0, 'still one session');
        t.tick(11 * 60_000);
        await t.m.expire();
        assert.equal(t.m.list().length, 0);
        assert.equal(t.closed(), 1);
        await t.m.stop();
    });
});
