import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseOsPackages, instanceRefusal, osUpdatesFrom, supportedCommands } from '../src/lib/commands';
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
            'logs',
            'adapter',
            'software',
        ]);
        assert.deepEqual(supportedCommands('6.0.11', 'linux'), [
            'instance',
            'restart',
            'osUpgrade',
            'logs',
            'adapter',
            'software',
        ]);
        assert.deepEqual(supportedCommands('5.0.19', 'linux'), ['instance', 'restart', 'logs', 'adapter', 'software']);
        assert.deepEqual(supportedCommands('7.0.7', 'win32'), ['instance', 'restart', 'logs', 'adapter', 'software']);
        assert.deepEqual(supportedCommands('', 'linux'), ['instance', 'restart', 'logs', 'adapter', 'software']);
    });

    it('reads the packages js-controller listed', () => {
        const lines = [
            'openssl/stable-security 3.0.17-1~deb12u2 arm64 [upgradable from: 3.0.15-1~deb12u1]',
            'nodejs/nodistro 22.21.0-1nodesource1 arm64 [upgradable from: 22.20.0-1nodesource1]',
            'not a package line',
        ];
        assert.deepEqual(osUpdatesFrom(state(JSON.stringify(lines), 4711), true), {
            packages: [
                { name: 'openssl', version: '3.0.17-1~deb12u2', from: '3.0.15-1~deb12u1' },
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
