import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repoCatalog, repoInfo, safeLink } from '../src/lib/repo';

describe('repositories of admin', () => {
    it('merges the active repositories as js-controller does', () => {
        const catalog = repoCatalog(['stable', 'own'], {
            stable: {
                link: 'http://download.iobroker.net/sources-dist.json',
                time: '2026-11-11T06:00:00.000Z',
                json: {
                    _repoInfo: { stable: true },
                    admin: { version: '7.6.17' },
                    javascript: { version: '9.1.2' },
                    'js-controller': { version: '7.0.7' },
                },
            },
            own: {
                link: 'https://user:secret@vendor.example/repo.json?key=abc',
                json: { javascript: { version: '9.2.0' } },
            },
            beta: {
                link: 'http://download.iobroker.net/sources-dist-latest.json',
                json: { admin: { version: '8.0.0' } },
            },
        });
        assert.deepEqual(catalog?.active, [
            {
                name: 'stable',
                link: 'http://download.iobroker.net/sources-dist.json',
                time: Date.parse('2026-11-11T06:00:00Z'),
            },
            { name: 'own', link: 'https://vendor.example/repo.json', time: null },
        ]);
        assert.deepEqual(repoInfo(catalog, ['admin', 'javascript', 'flow']), {
            active: catalog!.active,
            versions: { admin: '7.6.17', javascript: '9.2.0', 'js-controller': '7.0.7' },
        });
    });

    it('knows the name of one repository, not yet loaded, and none at all', () => {
        const catalog = repoCatalog('beta', { beta: 'http://download.iobroker.net/sources-dist-latest.json' });
        assert.deepEqual(catalog, {
            active: [{ name: 'beta', link: 'http://download.iobroker.net/sources-dist-latest.json', time: null }],
            versions: {},
        });
        assert.deepEqual(repoInfo(catalog, ['admin'])?.versions, {});
        assert.equal(repoCatalog(undefined, {}), undefined);
        assert.equal(repoCatalog([], {}), undefined);
        assert.deepEqual(repoCatalog(['gone'], undefined)?.active, [{ name: 'gone', link: '', time: null }]);
        assert.equal(repoInfo(undefined, ['admin']), undefined);
    });

    it('drops keys from links', () => {
        assert.equal(safeLink('https://a:b@x.example/r.json?apiKey=1#x'), 'https://x.example/r.json');
        assert.equal(safeLink('/opt/repo.json?x'), '/opt/repo.json');
    });
});
