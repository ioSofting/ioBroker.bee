import assert from 'node:assert/strict';
import type { CpuInfo } from 'node:os';
import { describe, it } from 'node:test';
import { cpuPercent, cpuTimes } from '../src/lib/inventory';

const core = (user: number, sys: number, idle: number): CpuInfo => ({
    model: 'Cortex-A76',
    speed: 2400,
    times: { user, nice: 0, sys, idle, irq: 0 },
});

describe('use of the CPU between two heartbeats', () => {
    it('all cores together', () => {
        const a = cpuTimes([core(1000, 500, 8500), core(2000, 0, 8000)], 0);
        assert.deepEqual(a, { ts: 0, busy: 3500, total: 20000 });
        // core 1 fully busy, core 2 idle: 50 %
        const b = cpuTimes([core(2000, 500, 8500), core(2000, 0, 9000)], 1000);
        assert.equal(cpuPercent(a, b), 50);
        // a quarter on one of four cores
        const four = [core(0, 0, 0), core(0, 0, 0), core(0, 0, 0), core(0, 0, 0)];
        const later = [core(250, 0, 750), core(0, 0, 1000), core(0, 0, 1000), core(0, 0, 1000)];
        assert.equal(cpuPercent(cpuTimes(four), cpuTimes(later)), 6.3);
    });

    it('no time between the readings, or counters that went back', () => {
        const a = cpuTimes([core(1000, 0, 1000)], 0);
        assert.equal(cpuPercent(a, a), null);
        assert.equal(cpuPercent(a, cpuTimes([core(10, 0, 10)], 1)), null);
    });

    it('the real readings of this system', () => {
        const v = cpuPercent(cpuTimes(), cpuTimes(undefined, Date.now()));
        assert.ok(v === null || (v >= 0 && v <= 100));
    });
});
