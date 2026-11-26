import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { identityAction, tokenHash, type DeviceFile } from '../src/lib/identity';

const creds = (extra: Partial<DeviceFile> = {}): DeviceFile => ({
    deviceId: 'dev-1',
    tenantId: 'iobroker',
    assetId: 'a-1',
    mqttUrl: 'mqtts://beekeeper.one:8883',
    cert: 'CERT',
    key: 'KEY',
    ca: 'CA',
    ...extra,
});

describe('identity of the device', () => {
    it('enrolls without a stored identity', () => {
        assert.equal(identityAction(null, 'iobroker.abc'), 'enroll');
        assert.equal(identityAction(null, ''), 'enroll');
    });

    it('keeps the identity of the same token, also with spaces around it', () => {
        const stored = creds({ tokenHash: tokenHash('iobroker.abc') });
        assert.equal(identityAction(stored, 'iobroker.abc'), 'keep');
        assert.equal(identityAction(stored, ' iobroker.abc\n'), 'keep');
    });

    it('keeps the identity when the token was removed from the settings', () => {
        assert.equal(identityAction(creds({ tokenHash: tokenHash('iobroker.abc') }), ''), 'keep');
        assert.equal(identityAction(creds(), '  '), 'keep');
    });

    it('enrolls anew with another token, of the same or of another tenant', () => {
        const stored = creds({ tokenHash: tokenHash('iobroker.abc') });
        assert.equal(identityAction(stored, 'iobroker.xyz'), 'enroll');
        assert.equal(identityAction(stored, 'dikikh.abc'), 'enroll');
    });

    it('without a stored hash: enrolls with the token of another tenant, else remembers the token', () => {
        assert.equal(identityAction(creds(), 'dikikh.abc'), 'enroll');
        assert.equal(identityAction(creds(), 'iobroker.abc'), 'adopt');
    });
});
