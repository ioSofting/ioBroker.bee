import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
    ADAPTER_COMMAND_TIMEOUT,
    adapterCommandPaths,
    adapterCommandState,
    adapterRefusal,
    adapterStep,
    clearAdapterCommand,
} from '../src/lib/adapterCommand';
import type { DesiredMessage } from '../src/lib/protocol';

const temp = mkdtempSync(join(tmpdir(), 'bee-adapter-'));
after(() => rmSync(temp, { recursive: true, force: true }));

const desired = (mode: 'managed' | 'self', profile: boolean): DesiredMessage =>
    ({ mode, profile: profile ? { id: 'p1' } : null }) as unknown as DesiredMessage;

describe('adapter command', () => {
    it('refuses what it must not do', () => {
        assert.equal(adapterRefusal({ name: 'admin', version: '7.6.17' }, null), null);
        assert.equal(adapterRefusal({ name: 'bee', version: '0.2.6-beta.0' }, desired('managed', false)), null);
        assert.equal(adapterRefusal({ name: 'admin', version: '7.6.17' }, desired('self', true)), null);
        assert.match(adapterRefusal({ name: 'admin', version: '7.6.17' }, desired('managed', true))!, /Sollprofil/);
        assert.match(adapterRefusal({ name: 'js-controller', version: '7.0.7' }, null)!, /js-controller/);
        assert.match(adapterRefusal({ name: '../x', version: '1.0.0' }, null)!, /Adaptername/);
        assert.match(adapterRefusal({ name: 'admin', version: 'latest' }, null)!, /Version/);
        assert.match(adapterRefusal({ name: 'admin', version: '1.0.0; rm -rf /' }, null)!, /Version/);
        assert.match(adapterRefusal(undefined, null)!, /Adaptername/);
    });

    it('plans install, upgrade and downgrade', () => {
        assert.deepEqual(adapterStep('alexa2', '3.28.3', undefined, false), {
            action: 'install',
            adapter: 'alexa2',
            from: null,
            to: '3.28.3',
            status: 'pending',
        });
        assert.equal(adapterStep('admin', '8.3.12', '8.3.11', false)?.action, 'upgrade');
        assert.equal(adapterStep('admin', '7.6.17', '8.3.11', false)?.action, 'downgrade');
        assert.equal(adapterStep('bee', '0.2.6-beta.0', '0.2.5', true)?.action, 'upgrade');
        // the same version: nothing to do from npm, once more from a package (a build that kept the number)
        assert.equal(adapterStep('admin', '8.3.11', '8.3.11', false), null);
        assert.equal(adapterStep('admin', '8.3.11', '8.3.11', true)?.action, 'upgrade');
    });

    it('answers from the files of the runner', async () => {
        const paths = adapterCommandPaths(temp);
        assert.equal(await adapterCommandState(paths), undefined);
        const command = { ref: 'cmd_1', by: 'denis', name: 'admin', version: '8.3.12', startedAt: 1000 };
        writeFileSync(paths.command, JSON.stringify(command));
        writeFileSync(paths.runner, JSON.stringify({ phase: 'running', steps: [] }));
        assert.equal(await adapterCommandState(paths, 2000), null);
        assert.deepEqual(await adapterCommandState(paths, 1000 + ADAPTER_COMMAND_TIMEOUT + 1), {
            command,
            state: 'error',
            message: 'admin 8.3.12: keine Rückmeldung des Runners',
        });

        writeFileSync(paths.runner, JSON.stringify({ phase: 'done', steps: [] }));
        assert.deepEqual(await adapterCommandState(paths, 2000), {
            command,
            state: 'done',
            message: 'admin 8.3.12 installiert',
        });

        writeFileSync(
            paths.runner,
            JSON.stringify({
                phase: 'failed',
                error: 'upgrade admin fehlgeschlagen (Exit-Code 1)',
                steps: [{ detail: 'npm ERR! 404' }],
            }),
        );
        assert.equal(
            (await adapterCommandState(paths, 2000))?.message,
            'admin 8.3.12: upgrade admin fehlgeschlagen (Exit-Code 1): npm ERR! 404',
        );
        writeFileSync(paths.runner, JSON.stringify({ phase: 'halted', steps: [] }));
        assert.equal((await adapterCommandState(paths, 2000))?.message, 'admin 8.3.12: durch Not-Aus angehalten');

        await clearAdapterCommand(paths);
        assert.equal(await adapterCommandState(paths), undefined);
    });
});
