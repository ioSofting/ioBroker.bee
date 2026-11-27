import * as timers from 'node:timers';
import type { Timers } from '../src/lib/util';

/**
 * Timers of Node.js in place of those of the adapter. A timeout holds the test process until it fires,
 * as the tests wait for some of them; an interval does not (not every test stops its manager).
 */
export const nodeTimers: Timers = {
    setTimeout: (cb, ms, ...args) => timers.setTimeout(() => cb(...args), ms) as unknown as ioBroker.Timeout,
    clearTimeout: t => timers.clearTimeout(t as unknown as NodeJS.Timeout),
    setInterval: (cb, ms, ...args) => timers.setInterval(() => cb(...args), ms).unref() as unknown as ioBroker.Interval,
    clearInterval: t => timers.clearInterval(t as unknown as NodeJS.Timeout),
};
