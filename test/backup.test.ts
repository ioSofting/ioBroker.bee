import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backitupInfo, backupPath, cronDays, mainBackitup, pruneOwnBackups, recentOffDeviceBackup } from '../src/lib/backup';

const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 10, 11, 20, 0);

const instance = (native: Record<string, unknown>, id = 'backitup.0', enabled = true): ioBroker.InstanceObject =>
    ({
        _id: `system.adapter.${id}`,
        type: 'instance',
        common: { name: 'backitup', enabled, host: 'iobroker' },
        native: { minimalEnabled: true, minimalEveryXDays: 1, iobrokerCron: false, ...native },
    }) as unknown as ioBroker.InstanceObject;

const state = (val: ioBroker.StateValue, ts: number): ioBroker.State =>
    ({ val, ts, lc: ts, ack: true, from: 'system.adapter.backitup.0' }) as ioBroker.State;

const entry = (ts: number, storage: string | string[], error = 'none', type = 'iobroker'): Record<string, unknown> => ({
    date: 'x',
    name: `iobroker_${ts}_backupiobroker.tar.gz`,
    type,
    storage,
    filesize: '10 MB',
    filesizeBytes: 11427279,
    error,
    timestamp: ts,
});

describe('backup: BackItUp', () => {
    it('reads a daily backup to Google Drive that works', () => {
        const run = NOW - 17 * 3600_000;
        const info = backitupInfo(instance({ googledriveEnabled: true }), {
            success: state(true, run + 16_000),
            lastTime: state('11. November 2026 um 02:40 Uhr', run + 16_000),
            history: state(
                JSON.stringify([
                    entry(run, 'Google Drive'),
                    entry(run - DAY, 'Google Drive'),
                    entry(run - 2 * DAY, 'Nur lokal gespeichert'),
                ]),
                run + 16_000,
            ),
        });
        assert.deepEqual(info, {
            instance: 'backitup.0',
            enabled: true,
            scheduled: true,
            everyDays: 1,
            targets: ['googledrive'],
            lastRun: { ts: run + 16_000, ok: true },
            lastOk: { ts: run, size: 11427279 },
            lastOffDevice: run,
        });
        assert.equal(recentOffDeviceBackup({ offDevice: true, backitup: info }, NOW), true);
    });

    it('knows a failed run, also one whose error was ignored', () => {
        const run = NOW - 3600_000;
        const history = state(JSON.stringify([entry(run - DAY, ['FTP', 'NAS / Kopieren'])]), run - DAY);
        // the run stopped: no entry in the history, "error: ..." as time
        const stopped = backitupInfo(instance({ ftpEnabled: true, cifsEnabled: true, connectType: 'NFS' }), {
            success: state(false, run),
            lastTime: state('error: 11. November 2026 um 19:00 Uhr', run),
            history,
        });
        assert.deepEqual(stopped.targets, ['ftp', 'nfs']);
        assert.deepEqual(stopped.lastRun, { ts: run, ok: false });
        assert.equal(stopped.lastOk?.ts, run - DAY);
        assert.equal(stopped.lastOffDevice, run - DAY);

        // "Ignore backup errors": exit code 0, but the entry of the run has the error
        const ignored = backitupInfo(instance({ dropboxEnabled: true }), {
            success: state(true, run + 60_000),
            lastTime: state('11. November 2026 um 19:00 Uhr', run + 60_000),
            history: state(
                JSON.stringify([entry(run, 'Dropbox', '[dropbox] Upload failed'), entry(run - DAY, 'Dropbox')]),
                run,
            ),
        });
        assert.deepEqual(ignored.lastRun, { ts: run + 60_000, ok: false, error: '[dropbox] Upload failed' });
        assert.equal(ignored.lastOk?.ts, run - DAY);
    });

    it('has no run before the first backup, and only the backups of ioBroker count', () => {
        const info = backitupInfo(instance({ minimalEnabled: false }), {
            success: state(false, NOW - 400 * DAY),
            lastTime: state('No backups yet', NOW - 400 * DAY),
            history: state(JSON.stringify([entry(NOW - DAY, 'Google Drive', 'none', 'ccu')]), NOW - DAY),
        });
        assert.equal(info.scheduled, false);
        assert.deepEqual(info.targets, []);
        assert.equal(info.lastRun, null);
        assert.equal(info.lastOk, null);
        assert.equal(info.lastOffDevice, null);
        assert.equal(recentOffDeviceBackup({ offDevice: false, backitup: info }, NOW), false);
    });

    it('needs a recent backup outside the device for Node.js', () => {
        const old = backitupInfo(instance({ webdavEnabled: true, minimalEveryXDays: 3 }), {
            history: state(
                JSON.stringify([entry(NOW - DAY, 'Only stored locally'), entry(NOW - 5 * DAY, 'WebDAV')]),
                NOW,
            ),
        });
        assert.equal(old.everyDays, 3);
        assert.deepEqual(old.lastRun, { ts: NOW - DAY, ok: true });
        assert.equal(old.lastOffDevice, NOW - 5 * DAY);
        assert.equal(recentOffDeviceBackup({ offDevice: true, backitup: old }, NOW), false, '5 days > 3 + 1');
        assert.equal(recentOffDeviceBackup({ offDevice: true, backitup: old }, NOW - DAY - 1), true);
        assert.equal(recentOffDeviceBackup({ offDevice: true, backitup: null }, NOW), false, 'no BackItUp');
        assert.equal(recentOffDeviceBackup({ offDevice: true }, NOW), true, 'older agent data: the target counts');
    });

    it('estimates the interval of an own cron schedule', () => {
        assert.equal(cronDays('00 48 02 */1 * *'), 1);
        assert.equal(cronDays('00 48 02 */3 * *'), 3);
        assert.equal(cronDays('48 2 * * *'), 1);
        assert.equal(cronDays('0 0 3 * * 0'), 7);
        assert.equal(cronDays('0 0 3 * * 1-5'), 3);
        assert.equal(cronDays('0 0 3 1 * *'), 31);
        assert.equal(cronDays(''), 1);
        assert.equal(
            backitupInfo(instance({ iobrokerCron: true, iobrokerCronJob: '00 30 01 */7 * *' }), {}).everyDays,
            7,
        );
    });

    it('takes the instance that backs up ioBroker', () => {
        const ccu = instance({ minimalEnabled: false, ccuEnabled: true }, 'backitup.0');
        const main = instance({}, 'backitup.1');
        const off = instance({}, 'backitup.2', false);
        assert.equal(mainBackitup([off, ccu, main])?._id, 'system.adapter.backitup.1');
        assert.equal(mainBackitup([]), undefined);
    });
});

describe('own backups before jobs', () => {
    const dir = '/opt/iobroker/backups/';
    const file = (day: number): string => `${dir}2026_11_${String(day).padStart(2, '0')}-02_00_00_backupiobroker.tar.gz`;

    it('reads the path from the step, with or without the size', () => {
        assert.equal(backupPath(`${file(20)} (48 MB)`), file(20));
        assert.equal(backupPath(file(20)), file(20));
    });

    it('keeps the last three and deletes only archives of iobroker backup', () => {
        assert.deepEqual(pruneOwnBackups([], file(1)), { keep: [file(1)], remove: [] });
        assert.deepEqual(pruneOwnBackups([file(1), file(2), file(3)], file(4)), {
            keep: [file(2), file(3), file(4)],
            remove: [file(1)],
        });
        // the same file again (a job repeated within the second) counts once
        assert.deepEqual(pruneOwnBackups([file(2), file(3), file(4)], file(4)).remove, []);
        // something that is no archive of iobroker backup is forgotten, never deleted
        const strange = pruneOwnBackups(['/etc/passwd', file(2), file(3)], file(4));
        assert.deepEqual(strange, { keep: [file(2), file(3), file(4)], remove: [] });
    });
});
