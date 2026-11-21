import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aptFailure, aptUpgradeArgs, sudoDenied } from '../src/lib/apt';

// what js-controller answered on a Raspberry Pi whose package lists were a few days old
const STALE = `Command failed: sudo apt upgrade -y base-files

WARNING: apt does not have a stable CLI interface. Use with caution in scripts.

E: Failed to fetch http://deb.debian.org/debian-security/pool/updates/main/e/expat/libexpat1-dev_2.5.0-1%2bdeb12u4_arm64.deb  404  Not Found [IP: 2a04:4e42:200::644 80]
E: Failed to fetch http://deb.debian.org/debian-security/pool/updates/main/e/expat/libexpat1_2.5.0-1%2bdeb12u4_arm64.deb  404  Not Found [IP: 2a04:4e42:200::644 80]
E: Failed to fetch http://deb.debian.org/debian-security/pool/updates/main/o/openssl/libssl3_3.0.22-1%7edeb12u1_arm64.deb  404  Not Found [IP: 2a04:4e42:200::644 80]
E: Failed to fetch http://deb.debian.org/debian-security/pool/updates/main/i/imagemagick/imagemagick-6-common_6.9.11.60%2bdfsg-1.6%2bdeb12u13_all.deb  404  Not Found [IP: 2a04:4e42:200::644 80]
E: Failed to fetch http://deb.debian.org/debian-security/pool/updates/main/i/imagemagick/libmagickcore-6.q16-6_6.9.11.60%2bdfsg-1.6%2bdeb12u13_arm64.deb  404  Not Found [IP: 2a04:4e42:200::644 80]
E: Failed to fetch http://deb.debian.org/debian-security/pool/updates/main/i/imagemagick/libmagickwand-6.q16-6_6.9.11.60%2bdfsg-1.6%2bdeb12u13_arm64.deb  404  Not Found [IP: 2a04:4e42:200::644 80]
E: Failed to fetch http://deb.debian.org/debian-security/pool/updates/main/t/tzdata/tzdata_2026c-0%2bdeb12u1_all.deb  404  Not Found [IP: 2a04:4e42:200::644 80]
E: Failed to fetch http://deb.debian.org/debian-security/pool/updates/main/o/openssl/openssl_3.0.22-1%7edeb12u1_arm64.deb  404  Not Found [IP: 2a04:4e42:200::644 80]
E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?`;

describe('OS updates with apt-get', () => {
    it('upgrades only the chosen packages, without questions and keeping changed configuration files', () => {
        const args = aptUpgradeArgs(['openssl', 'libssl3']);
        assert.equal(args[0], 'apt-get');
        assert.deepEqual(args.slice(-4), ['install', '--only-upgrade', 'openssl', 'libssl3']);
        assert.ok(!args.includes('upgrade'), 'apt upgrade <name> would upgrade every package');
        for (const option of ['-y', 'Dpkg::Options::=--force-confdef', 'Dpkg::Options::=--force-confold']) {
            assert.ok(args.includes(option), option);
        }
    });

    it('explains outdated package lists instead of showing the output of apt', () => {
        const remote = aptFailure(STALE, 'pi-keller');
        assert.match(remote, /Paketlisten auf pi-keller sind veraltet/);
        assert.match(remote, /libexpat1-dev, libexpat1, libssl3, imagemagick-6-common, libmagickcore-6\.q16-6, libmagickwand-6\.q16-6 und 2 weitere/);
        assert.match(remote, /sudo apt update/);
        // on the own host the agent refreshed the lists just before: then the mirror is the cause
        assert.match(aptFailure(STALE), /gerade aktualisiert/);
    });

    it('names a running apt and an interrupted dpkg, else shows the errors only', () => {
        assert.match(aptFailure('E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 812 (unattended-upgr)'), /läuft gerade schon/);
        assert.match(aptFailure("E: dpkg was interrupted, you must manually run 'sudo dpkg --configure -a' to correct the problem."), /dpkg --configure -a/);
        const other = aptFailure('Reading package lists...\nWARNING: apt does not have a stable CLI interface.\nE: Unable to locate package foo');
        assert.equal(other, 'E: Unable to locate package foo');
    });

    it('tells a refusal of sudo from a failure of apt', () => {
        assert.ok(sudoDenied('sudo: a password is required'));
        assert.ok(sudoDenied('Sorry, user iobroker is not allowed to execute ...\nsudo: a password is required'));
        assert.ok(!sudoDenied('E: Unable to locate package foo'));
    });
});
