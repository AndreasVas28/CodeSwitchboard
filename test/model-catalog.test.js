'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchModelIds, createModelCatalog } = require('../lib/model-catalog');

test('creates a Codex model catalog with the preferred model first', () => {
  const catalog = createModelCatalog(['vendor/b', 'vendor/a'], 'vendor/b');
  assert.deepEqual(catalog.models.map((model) => model.slug), ['vendor/b', 'vendor/a']);
  assert.equal(catalog.models[0].visibility, 'list');
  assert.equal(catalog.models[0].base_instructions.length > 0, true);
});

test('loads and sorts provider model ids', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'vendor/b' }, { id: 'vendor/a' }, { id: 'vendor/a' }] })
  });
  assert.deepEqual(await fetchModelIds({ baseUrl: 'https://example.test/v1', apiKey: 'secret', fetchImpl }), ['vendor/a', 'vendor/b']);
});
