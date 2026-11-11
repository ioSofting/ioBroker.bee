import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DesiredMessage, JobStep } from '../src/lib/protocol';
import { checkResult, cliArgs, type RunnerFile } from '../src/runner';
import { nextInstance, softwarePlan, softwareRefusal, type SoftwareContext } from '../src/lib/softwareCommand';

const adapterObj = (common: Record<string, unknown> = {}): ioBroker.Object =>
    ({
        _id: 'system.adapter.x',
        type: 'adapter',
        common: { version: '1.2.3', ...common },
    }) as unknown as ioBroker.Object;

const ctx = (over: Partial<SoftwareContext> = {}): SoftwareContext => ({
    own: 'bee.0',
    host: 'pi',
    desired: null,
    adapterObj: adapterObj(),
    instances: [
        { id: 'javascript.0', host: 'pi' },
        { id: 'javascript.2', host: 'pi' },
    ],
    ...over,
});

const managed = (adapters: string[]): DesiredMessage =>
    ({
        mode: 'managed',
        profile: { id: 'p1', adapters: Object.fromEntries(adapters.map(a => [a, { version: '1.0.0' }])) },
    }) as unknown as DesiredMessage;

describe('software command', () => {
    it('refuses what it must not do', () => {
        assert.equal(softwareRefusal({ action: 'removeAdapter', adapter: 'javascript' }, ctx()), null);
        assert.equal(softwareRefusal({ action: 'addInstance', adapter: 'javascript' }, ctx()), null);
        assert.equal(
            softwareRefusal({ action: 'removeInstance', adapter: 'javascript', instance: 'javascript.2' }, ctx()),
            null,
        );
        assert.match(softwareRefusal({ action: 'upgrade', adapter: 'javascript' }, ctx())!, /Aktion/);
        assert.match(softwareRefusal(undefined, ctx())!, /Aktion/);
        assert.match(softwareRefusal({ action: 'removeAdapter', adapter: '../x' }, ctx())!, /Adaptername/);
        assert.match(softwareRefusal({ action: 'removeAdapter', adapter: 'js-controller' }, ctx())!, /js-controller/);
        // the agent itself
        assert.match(softwareRefusal({ action: 'removeAdapter', adapter: 'bee' }, ctx())!, /nur am Gerät/);
        assert.match(softwareRefusal({ action: 'addInstance', adapter: 'bee' }, ctx())!, /zweite Instanz/);
        assert.match(
            softwareRefusal({ action: 'removeInstance', adapter: 'bee', instance: 'bee.0' }, ctx())!,
            /nur am Gerät/,
        );
        // not installed
        assert.match(
            softwareRefusal({ action: 'addInstance', adapter: 'javascript' }, ctx({ adapterObj: null }))!,
            /nicht installiert/,
        );
        // the next job would install it again
        assert.match(
            softwareRefusal(
                { action: 'removeAdapter', adapter: 'javascript' },
                ctx({ desired: managed(['javascript']) }),
            )!,
            /Sollprofil/,
        );
        assert.equal(
            softwareRefusal({ action: 'removeAdapter', adapter: 'javascript' }, ctx({ desired: managed(['admin']) })),
            null,
        );
        // other hosts
        const multi = ctx({ instances: [{ id: 'javascript.0', host: 'other' }] });
        assert.match(softwareRefusal({ action: 'removeAdapter', adapter: 'javascript' }, multi)!, /anderen Hosts/);
        assert.match(
            softwareRefusal({ action: 'removeInstance', adapter: 'javascript', instance: 'javascript.0' }, multi)!,
            /Host other/,
        );
        assert.match(
            softwareRefusal({ action: 'removeInstance', adapter: 'javascript', instance: 'javascript.1' }, ctx())!,
            /gibt es auf dem Gerät nicht/,
        );
        assert.match(
            softwareRefusal({ action: 'removeInstance', adapter: 'javascript', instance: 'admin.0' }, ctx())!,
            /Ungültige Instanz/,
        );
        assert.match(
            softwareRefusal({ action: 'removeInstance', adapter: 'javascript', instance: 'javascript.0; rm' }, ctx())!,
            /Ungültige Instanz/,
        );
        // one instance only
        assert.match(
            softwareRefusal(
                { action: 'addInstance', adapter: 'javascript' },
                ctx({ adapterObj: adapterObj({ singleton: true }) }),
            )!,
            /nur eine Instanz/,
        );
        assert.match(
            softwareRefusal(
                { action: 'addInstance', adapter: 'javascript' },
                ctx({ adapterObj: adapterObj({ singletonHost: true }) }),
            )!,
            /je Host/,
        );
        assert.equal(
            softwareRefusal(
                { action: 'addInstance', adapter: 'javascript' },
                ctx({
                    adapterObj: adapterObj({ singletonHost: true }),
                    instances: [{ id: 'javascript.0', host: 'x' }],
                }),
            ),
            null,
        );
    });

    it('takes the next number as js-controller does', () => {
        assert.equal(nextInstance('javascript', []), 'javascript.0');
        assert.equal(nextInstance('javascript', ctx().instances), 'javascript.3');
    });

    it('plans the step for the runner', () => {
        assert.deepEqual(softwarePlan({ action: 'removeAdapter', adapter: 'javascript' }, ctx()).step, {
            action: 'remove',
            adapter: 'javascript',
            from: '1.2.3',
            to: null,
            status: 'pending',
        });
        const add = softwarePlan({ action: 'addInstance', adapter: 'javascript' }, ctx());
        assert.equal(add.step.instance, 'javascript.3');
        assert.equal(add.done, 'Instanz javascript.3 angelegt');
        assert.deepEqual(cliArgs(add.step), [['add', 'javascript', '3']]);
        const del = softwarePlan({ action: 'removeInstance', adapter: 'javascript', instance: 'javascript.2' }, ctx());
        assert.deepEqual(cliArgs(del.step), [['del', 'javascript.2']]);
    });

    it('notices an instance js-controller kept', () => {
        const file = { cwd: '.' } as RunnerFile;
        const step: JobStep = { action: 'removeInstance', adapter: 'web', instance: 'web.0', status: 'running' };
        assert.equal(checkResult(file, step, 'Delete instance "web.0"\n'), null);
        assert.equal(
            checkResult(file, step, 'Cannot remove instance "web.0", because instance "vis-2.0" depends on it!\n'),
            'Cannot remove instance "web.0", because instance "vis-2.0" depends on it!',
        );
    });
});
