import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { instanceRefusal } from '../src/lib/commands';
import { instanceRunning, webExtensionOf } from '../src/lib/instances';

const instance = (
    id: string,
    common: Record<string, unknown>,
    native: Record<string, unknown> = {},
): ioBroker.InstanceObject =>
    ({
        _id: `system.adapter.${id}`,
        type: 'instance',
        common: { host: 'pi', enabled: true, mode: 'daemon', ...common },
        native,
    }) as unknown as ioBroker.InstanceObject;

const states =
    (values: Record<string, unknown>) =>
    (id: string): Promise<ioBroker.State | null> =>
        Promise.resolve(
            id in values ? ({ val: values[id], ack: true, ts: 1, lc: 1, from: 'x' } as ioBroker.State) : null,
        );

const mcp = (webInstance: string, enabled = true): ioBroker.InstanceObject =>
    instance('mcp.0', { enabled, webExtension: 'build/lib/mcp-server.js' }, { webInstance });

describe('instances', () => {
    it('recognizes a web extension the way admin does', () => {
        assert.equal(webExtensionOf(mcp('web.0')), 'web.0');
        assert.equal(webExtensionOf(mcp('system.adapter.web.1')), 'web.1');
        assert.equal(webExtensionOf(mcp('*')), '*');
        assert.equal(webExtensionOf(mcp('')), undefined, 'own web server');
        assert.equal(webExtensionOf(mcp('web.0', false)), undefined, 'switched off');
        assert.equal(webExtensionOf(instance('javascript.0', {})), undefined);
    });

    it('a web extension runs when its web instance runs, not by its own alive', async () => {
        const none = (): Promise<string[]> => Promise.resolve([]);
        const webUp = states({ 'system.adapter.web.0.alive': true, 'system.adapter.mcp.0.alive': false });
        assert.equal(await instanceRunning(mcp('web.0'), webUp, none), true);
        assert.equal(
            await instanceRunning(mcp('web.0'), states({ 'system.adapter.web.0.alive': false }), none),
            false,
            'web is down',
        );
        assert.equal(
            await instanceRunning(
                mcp('web.0'),
                states({ 'system.adapter.web.0.alive': true, 'mcp.0.info.extension': false }),
                none,
            ),
            false,
            'the extension says it is not loaded',
        );
        const two = (): Promise<string[]> => Promise.resolve(['web.0', 'web.1']);
        assert.equal(await instanceRunning(mcp('*'), states({ 'system.adapter.web.1.alive': true }), two), true);
        assert.equal(await instanceRunning(mcp('*'), states({}), two), false);
    });

    it('other instances by their own alive', async () => {
        const none = (): Promise<string[]> => Promise.resolve([]);
        const js = instance('javascript.0', {});
        assert.equal(await instanceRunning(js, states({ 'system.adapter.javascript.0.alive': true }), none), true);
        assert.equal(await instanceRunning(js, states({}), none), false);
        assert.equal(
            await instanceRunning(mcp(''), states({ 'system.adapter.mcp.0.alive': true }), none),
            true,
            'mcp with its own web server',
        );
    });

    it('does not restart a web extension (web would ignore it), but starts and stops it', () => {
        assert.match(instanceRefusal('mcp.0', 'restart', 'bee.0', mcp('web.0'), 'pi')!, /Erweiterung in web\.0/);
        assert.equal(instanceRefusal('mcp.0', 'stop', 'bee.0', mcp('web.0'), 'pi'), null);
        assert.equal(instanceRefusal('mcp.0', 'start', 'bee.0', mcp('web.0', false), 'pi'), null);
    });
});
