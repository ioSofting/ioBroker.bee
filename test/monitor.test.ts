import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { holds, limitOf, Monitor, validRules } from '../src/lib/monitor';

const T0 = 1_800_000_000_000;
const state = (val: ioBroker.StateValue, ts = T0): ioBroker.State => ({ val, ts, ack: true, lc: ts, from: 'system.adapter.victron.0' });

describe('monitoring of states', () => {
    it('takes only rules that can work and fills in the defaults', () => {
        const rules = validRules([
            { stateId: ' victron.0.voltage ', op: '<', value: '11,5', severity: 'warning' },
            { stateId: 'victron.0.soc', op: '<', value: '' },
            { stateId: '', op: '<', value: '1' },
            { stateId: 'x.0.y', op: '~', value: '1' },
            { stateId: 'x.0.z', op: 'stale', value: '0' },
            { stateId: 'x.0.w', op: 'stale', value: '30', severity: 'bogus', delay: '5', label: ' Hängt ' },
        ]);
        assert.deepEqual(rules, [
            { stateId: 'victron.0.voltage', op: '<', value: '11,5', severity: 'warning', delay: 60 },
            { stateId: 'x.0.w', op: 'stale', value: '30', severity: 'warning', delay: 5, label: 'Hängt' },
        ]);
        assert.deepEqual(validRules('nonsense'), []);
    });

    it('reads limits with a comma or a unit as numbers', () => {
        assert.equal(limitOf('11,5'), '11.5');
        assert.equal(limitOf('11.5 V'), '11.5');
        assert.equal(limitOf('-3'), '-3');
        assert.equal(limitOf('true'), 'true');
        const rule = { stateId: 's', op: '<' as const, value: '11,5 V', severity: 'warning' as const };
        assert.equal(holds(rule, { val: 11.2, ts: T0 }, T0), true);
        assert.equal(holds(rule, { val: '12.1', ts: T0 }, T0), false);
        assert.equal(holds(rule, { val: null, ts: T0 }, T0), null);
        assert.equal(holds(rule, undefined, T0), null);
    });

    it('alerts once the condition held for the delay and stops once it is gone as long', () => {
        const m = new Monitor(validRules([{ stateId: 'victron.0.voltage', op: '<', value: '11.5', severity: 'warning', delay: 60 }]), T0);
        m.setUnit('victron.0.voltage', 'V');
        m.update('victron.0.voltage', state(12.4));
        assert.deepEqual(m.evaluate(T0), []);
        // a dip under load for 20 s raises nothing
        m.update('victron.0.voltage', state(11.1, T0 + 10_000));
        m.evaluate(T0 + 10_000);
        m.update('victron.0.voltage', state(12.3, T0 + 30_000));
        assert.deepEqual(m.evaluate(T0 + 30_000), []);
        assert.deepEqual(m.evaluate(T0 + 200_000), []);
        // low for good
        m.update('victron.0.voltage', state(11.2, T0 + 300_000));
        assert.deepEqual(m.evaluate(T0 + 300_000), []);
        const [alert] = m.evaluate(T0 + 361_000);
        assert.equal(alert.alert, true);
        assert.equal(alert.since, T0 + 300_000);
        assert.equal(alert.val, 11.2);
        assert.equal(alert.unit, 'V');
        assert.equal(alert.id, 'victron.0.voltage < 11.5');
        // the value the alert began with stays, so the deviation does not change with every value
        m.update('victron.0.voltage', state(11, T0 + 400_000));
        assert.deepEqual(m.evaluate(T0 + 400_000), []);
        assert.equal(m.status()[0].val, 11.2);
        // charging again: over the limit, but only short
        m.update('victron.0.voltage', state(12.8, T0 + 500_000));
        assert.deepEqual(m.evaluate(T0 + 500_000), []);
        assert.deepEqual(m.evaluate(T0 + 530_000), []);
        const [ok] = m.evaluate(T0 + 560_000);
        assert.equal(ok.alert, false);
        assert.equal(ok.val, 12.8);
        assert.equal(ok.since, undefined);
    });

    it('reports a state that stopped changing, and one that does not exist', () => {
        const m = new Monitor(
            validRules([
                { stateId: 'victron.0.voltage', op: 'stale', value: '30', severity: 'error', delay: 0 },
                { stateId: 'victron.0.typo', op: '>', value: '1', severity: 'warning' },
            ]),
            T0,
        );
        m.update('victron.0.voltage', state(12.4, T0));
        m.update('victron.0.typo', null);
        const first = m.evaluate(T0 + 1000);
        assert.deepEqual(first.map(s => [s.stateId, s.alert, !!s.missing]), [['victron.0.typo', false, true]]);
        assert.deepEqual(m.evaluate(T0 + 29 * 60_000), []);
        const [stale] = m.evaluate(T0 + 31 * 60_000);
        assert.equal(stale.alert, true);
        assert.equal(stale.ts, T0);
        m.update('victron.0.voltage', state(12.4, T0 + 32 * 60_000));
        assert.equal(m.evaluate(T0 + 32 * 60_000)[0].alert, false);
    });
});
