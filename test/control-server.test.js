'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const { createControlServer } = require('../lib/control-server');

function testTargets() {
  return [{
    id: 'codex-cli', name: 'Codex CLI', kind: 'cli', command: 'codex',
    routing: 'bridge', description: 'Test target', installed: true
  }];
}

function testStore() {
  const data = { keys: {}, overrides: {}, selections: {} };
  return {
    keys: () => ({ ...data.keys }),
    providerOverrides: () => ({ ...data.overrides }),
    selections: () => ({ ...data.selections }),
    setKey(id, value) { if (value) data.keys[id] = value; else delete data.keys[id]; },
    setProviderOverride(id, value) { if (value) data.overrides[id] = value; else delete data.overrides[id]; },
    updateSelections(values) { Object.assign(data.selections, values); }
  };
}

test('control server serves the dashboard and never returns provider keys', async (context) => {
  const launches = [];
  const launcher = {
    launch: async (request) => { launches.push(request); return { message: 'Launched in test.' }; },
    close() {}
  };
  const control = createControlServer({
    persistentStore: testStore(),
    launcher,
    targetDetector: testTargets,
    modelFetcher: async ({ baseUrl, apiKey }) => {
      assert.equal(baseUrl, 'https://models.example/v1');
      assert.equal(apiKey, 'super-secret');
      return ['vendor/model-a', 'vendor/model-b'];
    }
  });
  const address = await control.listen(0);
  context.after(() => control.close());
  const root = `http://127.0.0.1:${address.port}`;

  const page = await fetch(root);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /CodeSwitchboard/);

  const configured = await fetch(`${root}/api/providers/custom`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: root },
    body: JSON.stringify({ baseUrl: 'https://models.example/v1/', apiKey: 'super-secret' })
  });
  assert.equal(configured.status, 200);
  assert.doesNotMatch(await configured.text(), /super-secret/);

  const state = await (await fetch(`${root}/api/state`)).json();
  assert.equal(state.localOnly, true);
  assert.equal(state.providers.find((provider) => provider.id === 'custom').keyConfigured, true);
  assert.equal(JSON.stringify(state).includes('super-secret'), false);

  const models = await (await fetch(`${root}/api/providers/custom/models`)).json();
  assert.deepEqual(models.models, ['vendor/model-a', 'vendor/model-b']);

  const launch = await fetch(`${root}/api/launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: root },
    body: JSON.stringify({ providerId: 'custom', targetId: 'codex-cli', model: 'vendor/model-a', workspace: path.resolve('.') })
  });
  assert.equal(launch.status, 200);
  assert.equal(launches[0].apiKey, 'super-secret');
});

test('launch preserves a manually entered model omitted by discovery', async (context) => {
  const launches = [];
  const control = createControlServer({
    persistentStore: testStore(),
    launcher: { close() {}, launch: async (request) => { launches.push(request); return { message: 'ok' }; } },
    targetDetector: testTargets,
    modelFetcher: async () => ['catalog/model']
  });
  const address = await control.listen(0);
  context.after(() => control.close());
  const root = `http://127.0.0.1:${address.port}`;
  await fetch(`${root}/api/providers/custom`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: root }, body: JSON.stringify({ baseUrl: 'https://models.example/v1', apiKey: 'secret' }) });
  const response = await fetch(`${root}/api/launch`, { method: 'POST', headers: { 'content-type': 'application/json', origin: root }, body: JSON.stringify({ providerId: 'custom', targetId: 'codex-cli', model: 'manual/deployment', workspace: path.resolve('.') }) });
  assert.equal(response.status, 200);
  assert.equal(launches[0].model, 'manual/deployment');
});

test('control server rejects non-local write origins', async (context) => {
  const control = createControlServer({ launcher: { close() {}, launch: async () => ({}) }, targetDetector: testTargets, persistentStore: testStore() });
  const address = await control.listen(0);
  context.after(() => control.close());
  const response = await fetch(`http://127.0.0.1:${address.port}/api/providers/nvidia`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
    body: JSON.stringify({ apiKey: 'nope' })
  });
  assert.equal(response.status, 403);
});

test('local editor gateway lists connected models and routes prefixed model ids', async (context) => {
  let forwardedBody;
  const upstream = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    forwardedBody = JSON.parse(raw);
    assert.equal(request.headers.authorization, 'Bearer upstream-secret');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'chat_test', choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));

  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const control = createControlServer({
    persistentStore: testStore(),
    launcher: { close() {} },
    targetDetector: testTargets,
    modelFetcher: async () => ['vendor/model-a', 'vendor/model-b']
  });
  const address = await control.listen(0);
  context.after(() => control.close());
  const root = `http://127.0.0.1:${address.port}`;
  await fetch(`${root}/api/providers/custom`, {
    method: 'PUT', headers: { 'content-type': 'application/json', origin: root },
    body: JSON.stringify({ baseUrl: upstreamBase, apiKey: 'upstream-secret' })
  });

  const unauthorized = await fetch(`${root}/v1/models`);
  assert.equal(unauthorized.status, 401);
  const catalogResponse = await fetch(`${root}/v1/models`, { headers: { authorization: 'Bearer codeswitchboard-local' } });
  const catalog = await catalogResponse.json();
  assert.deepEqual(catalog.data.map((item) => item.id), ['custom/vendor/model-a', 'custom/vendor/model-b']);

  const completion = await fetch(`${root}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer codeswitchboard-local' },
    body: JSON.stringify({ model: 'custom/vendor/model-b', messages: [{ role: 'user', content: 'hello' }] })
  });
  assert.equal(completion.status, 200);
  assert.equal((await completion.json()).choices[0].message.content, 'OK');
  assert.equal(forwardedBody.model, 'vendor/model-b');
});
