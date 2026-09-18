import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDependencies, computePlan, foreignAdapters, rollbackPlan } from '../src/lib/planner';
import { compare, preflight } from '../src/lib/preflight';
import type { DesiredMessage, ProfileAdapter } from '../src/lib/protocol';
import { diffFlat, flatten, inWindow } from '../src/lib/util';

function desired(adapters: Record<string, ProfileAdapter>, extra: Partial<DesiredMessage> = {}): DesiredMessage {
    return {
        v: 1,
        ts: 0,
        assetId: 'ast_1',
        mode: 'managed',
        profile: { id: 'prf_1', name: 'womo-2026.4', hash: 'abc', jsController: '7.0.7', node: '22', adapters },
        tolerated: [],
        remove: [],
        retry: 0,
        ...extra,
    };
}

describe('planner', () => {
    it('plans install, upgrade, downgrade, removal and updates itself last', () => {
        const d = desired(
            {
                admin: { version: '7.7.2' },
                bee: { version: '0.2.0' },
                javascript: { version: '9.0.0' },
                web: { version: '7.0.9' },
                mopeka: { version: '1.0.6' },
            },
            { remove: ['spotify-premium'] },
        );
        const plan = computePlan(d, {
            admin: '7.6.17',
            bee: '0.1.0',
            javascript: '9.2.0',
            web: '7.0.9',
            'spotify-premium': '1.5.2',
        });
        assert.deepEqual(
            plan.map(s => `${s.action} ${s.adapter} ${s.from ?? '-'} ${s.to ?? '-'}`),
            [
                'remove spotify-premium 1.5.2 -',
                'upgrade admin 7.6.17 7.7.2',
                'downgrade javascript 9.2.0 9.0.0',
                'install mopeka - 1.0.6',
                'upgrade bee 0.1.0 0.2.0',
            ],
        );
    });

    it('does not touch adapters outside the profile but reports them', () => {
        const d = desired({ admin: { version: '7.7.2' } }, { tolerated: ['telegram'] });
        const installed = { admin: '7.7.2', telegram: '4.1.0', zigbee: '2.0.0' };
        assert.deepEqual(computePlan(d, installed), []);
        assert.deepEqual(foreignAdapters(d, installed), ['zigbee']);
    });

    it('rolls back successful steps in reverse order', () => {
        const back = rollbackPlan([
            { action: 'backup', status: 'ok' },
            { action: 'upgrade', adapter: 'admin', from: '7.6.17', to: '7.7.2', status: 'ok' },
            { action: 'install', adapter: 'mopeka', from: null, to: '1.0.6', status: 'ok' },
            { action: 'upgrade', adapter: 'vis-2', from: '2.12.12', to: '2.13.1', status: 'error' },
        ]);
        assert.deepEqual(
            back.map(s => `${s.action} ${s.adapter} ${s.to ?? '-'}`),
            ['remove mopeka -', 'downgrade admin 7.6.17'],
        );
    });

    it('checks dependencies against the state after the plan', () => {
        const d = desired({
            admin: { version: '7.7.2', dependencies: [{ 'js-controller': '>=7.1.0' }] },
            'vis-2': { version: '2.13.1', dependencies: [{ web: '>=7.1.0' }], node: '>=22' },
            web: { version: '7.0.9' },
        });
        const errors = checkDependencies(d, { admin: '7.6.17', web: '7.0.9' }, { jsController: '7.0.7', node: 'v20.18.0' });
        assert.equal(errors.length, 3);
        assert.match(errors[0], /js-controller >=7.1.0/);
        assert.ok(errors.some(e => /Node >=22/.test(e)));
        assert.ok(errors.some(e => /web >=7.1.0, vorhanden ist 7.0.9/.test(e)));
    });
});

describe('preflight', () => {
    const base = {
        now: new Date(2026, 8, 18, 3, 0),
        halted: false,
        window: { start: '02:00', end: '05:00', ignore: false },
        conditions: [],
        readState: async (): Promise<ioBroker.StateValue | undefined> => undefined,
        diskPath: '.',
        minFreeMb: 1,
        dependencyErrors: [],
    };

    it('passes inside the window', async () => {
        assert.deepEqual(await preflight(base), { ok: true });
    });

    it('waits outside the window and during an emergency stop', async () => {
        const r1 = await preflight({ ...base, now: new Date(2026, 8, 18, 14, 0) });
        assert.equal(r1.ok, false);
        assert.equal(!r1.ok && r1.kind, 'wait');
        const r2 = await preflight({ ...base, halted: true });
        assert.equal(!r2.ok && r2.kind, 'wait');
    });

    it('waits while a condition is not met, blocks on dependency errors', async () => {
        const r1 = await preflight({
            ...base,
            conditions: [{ stateId: 'victron.0.soc', op: '>=', value: '50', label: 'Aufbaubatterie' }],
            readState: async () => 30,
        });
        assert.equal(!r1.ok && r1.kind, 'wait');
        assert.match(!r1.ok ? r1.reason : '', /Aufbaubatterie: 30/);
        const r2 = await preflight({ ...base, dependencyErrors: ['x'] });
        assert.equal(!r2.ok && r2.kind, 'block');
    });

    it('compares state values sensibly', () => {
        assert.equal(compare('55', '>=', '50'), true);
        assert.equal(compare(false, '==', 'false'), true);
        assert.equal(compare(0, '==', 'false'), true);
        assert.equal(compare('roaming', '!=', 'roaming'), false);
    });
});

describe('util', () => {
    it('maintenance window spanning midnight', () => {
        assert.equal(inWindow(new Date(2026, 0, 1, 23, 30), '22:00', '05:00'), true);
        assert.equal(inWindow(new Date(2026, 0, 1, 4, 59), '22:00', '05:00'), true);
        assert.equal(inWindow(new Date(2026, 0, 1, 5, 0), '22:00', '05:00'), false);
    });

    it('inventory diff contains only changes', () => {
        const a = flatten({ software: { adapters: { admin: { version: '1' }, web: { version: '2' } } } });
        const b = flatten({ software: { adapters: { admin: { version: '3' } } } });
        assert.deepEqual(diffFlat(a, b), {
            set: { '/software/adapters/admin/version': '3' },
            unset: ['/software/adapters/web/version'],
        });
    });
});
