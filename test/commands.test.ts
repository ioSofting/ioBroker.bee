import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    chooseAdminInstance,
    chooseOsPackages,
    controllerRefusal,
    instanceRefusal,
    osUpdatesFrom,
    supportedCommands,
} from '../src/lib/commands';
import { parseOsPackage } from '../src/lib/protocol';

const instance = (host: string, enabled: boolean): ioBroker.Object =>
    ({
        _id: 'system.adapter.x.0',
        type: 'instance',
        common: { host, enabled },
        native: {},
    }) as unknown as ioBroker.Object;

const state = (val: unknown, ts = 1000): ioBroker.State =>
    ({ val, ts, ack: true, lc: ts, from: 'system.host.pi' }) as ioBroker.State;

describe('commands of the fleet management', () => {
    it('offers OS updates only on Linux with js-controller 6 or newer', () => {
        assert.deepEqual(supportedCommands('7.0.7', 'linux'), [
            'instance',
            'restart',
            'osUpgrade',
            'controller',
            'logs',
            'adapter',
            'software',
            'mcp',
        ]);
        assert.deepEqual(supportedCommands('6.0.11', 'linux'), [
            'instance',
            'restart',
            'osUpgrade',
            'controller',
            'logs',
            'adapter',
            'software',
            'mcp',
        ]);
        assert.deepEqual(supportedCommands('5.0.19', 'linux'), [
            'instance',
            'restart',
            'controller',
            'logs',
            'adapter',
            'software',
            'mcp',
        ]);
        assert.deepEqual(supportedCommands('7.0.7', 'win32'), [
            'instance',
            'restart',
            'logs',
            'adapter',
            'software',
            'mcp',
        ]);
        assert.deepEqual(supportedCommands('', 'linux'), ['instance', 'restart', 'logs', 'adapter', 'software', 'mcp']);
    });

    it('lets js-controller upgrade itself only on Linux from version 5', () => {
        assert.ok(!supportedCommands('4.0.24', 'linux').includes('controller'));
        assert.ok(!supportedCommands('7.0.7', 'win32').includes('controller'));
        assert.ok(!supportedCommands('', 'linux').includes('controller'));
    });

    it('takes an upgrade of js-controller only to a newer version', () => {
        assert.equal(controllerRefusal({ version: '7.0.7' }, '6.0.11', 'linux'), null);
        assert.equal(controllerRefusal({ version: '7.1.0-alpha.3' }, '7.0.7', 'linux'), null);
        assert.match(controllerRefusal({ version: '7.0.7' }, '7.0.7', 'linux')!, /schon installiert/);
        assert.match(controllerRefusal({ version: '6.0.11' }, '7.0.7', 'linux')!, /zurückstufen/);
        assert.equal(controllerRefusal({ version: 'latest' }, '7.0.7', 'linux'), 'Ungültige Version');
        assert.equal(controllerRefusal({ version: '7.0.7; rm -rf /' }, '6.0.11', 'linux'), 'Ungültige Version');
        assert.equal(controllerRefusal(undefined, '6.0.11', 'linux'), 'Ungültige Version');
        assert.match(controllerRefusal({ version: '7.0.7' }, '6.0.11', 'win32')!, /nur unter Linux/);
    });

    it('chooses the admin instance whose port shows the progress of the upgrade', () => {
        const admin = (n: number, host: string, enabled: boolean): ioBroker.Object =>
            ({
                _id: `system.adapter.admin.${n}`,
                type: 'instance',
                common: { host, enabled },
                native: {},
            }) as unknown as ioBroker.Object;
        assert.equal(chooseAdminInstance([admin(0, 'pi', true), admin(1, 'nuc', true)], 'nuc'), 1);
        assert.equal(chooseAdminInstance([admin(0, 'pi', false), admin(1, 'nuc', true)], 'pi'), 1);
        assert.equal(chooseAdminInstance([admin(2, 'pi', false)], 'pi'), 2);
        assert.equal(chooseAdminInstance([], 'pi'), null);
    });

    it('reads the packages js-controller listed', () => {
        const lines = [
            'openssl/stable-security 3.0.17-1~deb12u2 arm64 [upgradable from: 3.0.15-1~deb12u1]',
            'nodejs/nodistro 22.21.0-1nodesource1 arm64 [upgradable from: 22.20.0-1nodesource1]',
            'not a package line',
        ];
        assert.deepEqual(osUpdatesFrom(state(JSON.stringify(lines), 4711), true), {
            packages: [
                // from a security suite (protocol shared with bee-linux)
                { name: 'openssl', version: '3.0.17-1~deb12u2', from: '3.0.15-1~deb12u1', security: true },
                { name: 'nodejs', version: '22.21.0-1nodesource1', from: '22.20.0-1nodesource1' },
            ],
            checkedAt: 4711,
            rebootRequired: true,
        });
        assert.deepEqual(osUpdatesFrom(state('[]'), false)?.packages, []);
        assert.equal(osUpdatesFrom(null, false), undefined, 'older js-controller: no state');
        assert.equal(osUpdatesFrom(state('no json'), false), undefined);
        assert.equal(parseOsPackage('Listing...'), null);
    });

    it('takes only packages js-controller listed', () => {
        const listed = [{ name: 'openssl' }, { name: 'tzdata' }];
        assert.deepEqual(chooseOsPackages(listed, ['tzdata']), { packages: [{ name: 'tzdata' }], unknown: [] });
        assert.deepEqual(chooseOsPackages(listed, ['tzdata', 'openssh-server']).unknown, ['openssh-server']);
        assert.deepEqual(chooseOsPackages(listed, 'openssl'), { packages: [], unknown: [] });
    });

    it('checks commands for instances', () => {
        const ok = instance('pi', true);
        assert.equal(instanceRefusal('javascript.0', 'restart', 'bee.0', ok, 'pi'), null);
        assert.equal(instanceRefusal('bee.0', 'restart', 'bee.0', ok, 'pi'), null, 'its own restart is fine');
        assert.match(instanceRefusal('bee.0', 'stop', 'bee.0', ok, 'pi')!, /trennt/);
        assert.match(instanceRefusal('javascript.0', 'restart', 'bee.0', instance('other', true), 'pi')!, /Host other/);
        assert.match(
            instanceRefusal('javascript.0', 'restart', 'bee.0', instance('pi', false), 'pi')!,
            /ausgeschaltet/,
        );
        assert.equal(instanceRefusal('javascript.0', 'start', 'bee.0', instance('pi', false), 'pi'), null);
        assert.match(instanceRefusal('javascript.0', 'kill', 'bee.0', ok, 'pi')!, /Unbekannte Aktion/);
        assert.match(instanceRefusal('system.adapter.x', 'start', 'bee.0', ok, 'pi')!, /Ungültige Instanz/);
        assert.match(instanceRefusal('javascript.0', 'start', 'bee.0', null, 'pi')!, /gibt es/);
    });
});
