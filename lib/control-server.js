'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PROVIDERS, providerById } = require('./provider-registry');
const { TARGETS, detectedTargets, TargetLauncher } = require('./target-registry');
const { fetchModelIds } = require('./model-catalog');
const { PersistentStore } = require('./persistent-store');
const { catalogTarget } = require('./target-catalog');
const { detectCatalog, installPlan, installTargetAsync, doctorTarget } = require('./target-manager');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request, limit = 64 * 1024) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('Invalid JSON request.'), { statusCode: 400 }); }
}

function assertLocalWrite(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch { throw Object.assign(new Error('Invalid request origin.'), { statusCode: 403 }); }
  const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (!localHost || parsed.host !== request.headers.host) {
    throw Object.assign(new Error('CodeSwitchboard only accepts local requests.'), { statusCode: 403 });
  }
}

function normalizedBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL must use http or https.');
  return url.toString().replace(/\/$/, '');
}

function createControlServer(options = {}) {
  const publicDirectory = options.publicDirectory || path.join(__dirname, '..', 'public');
  const legacyLauncherPath = options.legacyLauncherPath || path.join(__dirname, '..', 'bin', 'free-codex.js');
  const launcher = options.launcher || new TargetLauncher({ legacyLauncherPath });
  const modelFetcher = options.modelFetcher || fetchModelIds;
  const targetDetector = options.targetDetector || detectedTargets;
  const catalogDetector = options.catalogDetector || detectCatalog;
  const persistentStore = options.persistentStore || new PersistentStore();
  const savedKeys = persistentStore.keys();
  const providerKeys = new Map(Object.entries(savedKeys));
  const persistedKeyIds = new Set(Object.keys(savedKeys));
  const providerOverrides = new Map(Object.entries(persistentStore.providerOverrides()));
  const modelCache = new Map();

  function configuredProvider(id) {
    const preset = providerById(id);
    if (!preset) return null;
    const override = providerOverrides.get(id);
    return { ...preset, baseUrl: override?.baseUrl ?? preset.baseUrl };
  }

  function keyFor(provider) {
    return providerKeys.get(provider.id) || process.env[provider.env] || '';
  }

  async function modelsFor(provider) {
    const apiKey = keyFor(provider);
    if (!apiKey) return [];
    const cached = modelCache.get(provider.id);
    if (cached && cached.baseUrl === provider.baseUrl && Date.now() - cached.loadedAt < 60_000) return cached.models;
    const models = await modelFetcher({ baseUrl: provider.baseUrl, apiKey });
    modelCache.set(provider.id, { models, baseUrl: provider.baseUrl, loadedAt: Date.now() });
    return models;
  }

  async function handleLocalGateway(request, response, url) {
    if (!url.pathname.startsWith('/v1/')) return false;
    if (request.headers.authorization !== 'Bearer codeswitchboard-local') {
      sendJson(response, 401, { error: { message: 'Use the local CodeSwitchboard key.' } });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      const connected = PROVIDERS.map((item) => configuredProvider(item.id)).filter((item) => item?.baseUrl && keyFor(item));
      const catalogs = await Promise.all(connected.map(async (provider) => ({ provider, models: await modelsFor(provider) })));
      sendJson(response, 200, {
        object: 'list',
        data: catalogs.flatMap(({ provider, models }) => models.map((id) => ({ id: `${provider.id}/${id}`, object: 'model', owned_by: provider.name })))
      });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readJson(request, 10 * 1024 * 1024);
      const routedModel = String(body.model || '');
      const slash = routedModel.indexOf('/');
      const provider = slash > 0 ? configuredProvider(routedModel.slice(0, slash)) : null;
      if (!provider || !keyFor(provider)) throw Object.assign(new Error(`Model must start with a connected provider, for example nvidia/model-id. Received: ${routedModel || '(empty)'}`), { statusCode: 400 });
      body.model = routedModel.slice(slash + 1);
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${keyFor(provider)}` };
      if (provider.id === 'openrouter') { headers['HTTP-Referer'] = 'http://127.0.0.1'; headers['X-Title'] = 'CodeSwitchboard'; }
      const upstream = await fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store'
      });
      if (!upstream.body) { response.end(); return true; }
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(Buffer.from(value));
      }
      response.end();
      return true;
    }
    sendJson(response, 404, { error: { message: 'Local gateway route not found.' } });
    return true;
  }

  function state() {
    const launchTargets = targetDetector().map((target) => ({
      ...target,
      routingLabel: ['bridge', 'compatible', 'anthropic', 'gemini', 'app-gateway', 'gateway-compatible'].includes(target.routing)
        ? 'Provider routed'
        : ['native', 'native-account'].includes(target.routing) ? 'Native account' : target.routing === 'account' ? 'Vendor login required' : 'Workspace only'
    }));
    const launchById = new Map(launchTargets.map((target) => [target.id, target]));
    const targetReceipts = persistentStore.targetReceipts?.() || {};
    return {
      brand: 'CodeSwitchboard',
      localOnly: true,
      workspace: process.cwd(),
      preferences: persistentStore.selections(),
      providers: PROVIDERS.map((preset) => {
        const provider = configuredProvider(preset.id);
        return {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          custom: Boolean(provider.custom),
          keyConfigured: Boolean(keyFor(provider)),
          keySource: persistedKeyIds.has(provider.id) ? 'encrypted on this PC' : (providerKeys.has(provider.id) ? 'session' : (process.env[provider.env] ? 'environment' : null))
        };
      }),
      targets: launchTargets,
      catalog: catalogDetector().map((target) => {
        const receipt = targetReceipts[target.id] || null;
        return {
          ...target,
          installed: launchById.get(target.id)?.installed ?? target.installed,
          version: target.version || receipt?.version || null,
          receipt,
          verificationStatus: target.verificationStatus || 'unverified'
        };
      })
    };
  }

  async function handleApi(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/state') {
      sendJson(response, 200, state());
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/catalog') {
      const mode = url.searchParams.get('mode');
      const catalog = state().catalog.filter((target) => !mode || target.mode === mode);
      sendJson(response, 200, { catalog });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/install-plan') {
      sendJson(response, 200, { plan: installPlan() });
      return true;
    }

    const targetApiMatch = url.pathname.match(/^\/api\/targets\/([^/]+)(?:\/(install|doctor|uninstall-routing))?$/);
    if (targetApiMatch) {
      const targetId = decodeURIComponent(targetApiMatch[1]);
      const action = targetApiMatch[2];
      const target = catalogTarget(targetId);
      if (!target) throw Object.assign(new Error('Unknown target.'), { statusCode: 404 });
      if (request.method === 'GET' && !action) {
        sendJson(response, 200, { target: state().catalog.find((item) => item.id === targetId) });
        return true;
      }
      if (request.method === 'GET' && action === 'doctor') {
        sendJson(response, 200, doctorTarget(targetId));
        return true;
      }
      if (request.method === 'POST' && action === 'install') {
        assertLocalWrite(request);
        const body = await readJson(request);
        const receipt = { ...await installTargetAsync(targetId, { update: Boolean(body.update) }), checkedAt: new Date().toISOString() };
        persistentStore.setTargetReceipt?.(targetId, receipt);
        sendJson(response, 200, { ok: true, receipt, target: detectCatalog([target])[0] });
        return true;
      }
      if (request.method === 'POST' && action === 'uninstall-routing') {
        assertLocalWrite(request);
        if (targetId === 'codex-desktop') {
          const result = spawnSync(process.execPath, [legacyLauncherPath, 'launch', 'codex-app', '--restore'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
          if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Could not restore Codex.').trim());
          sendJson(response, 200, { ok: true, message: result.stdout.trim() || 'Codex routing removed.' });
          return true;
        }
        if (targetId === 'claude-app') {
          const result = launcher.restoreClaudeDesktop();
          sendJson(response, 200, { ok: true, ...result });
          return true;
        }
        sendJson(response, 200, { ok: true, message: `${target.name} uses per-launch routing; no persistent vendor configuration needed removal.` });
        return true;
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/shutdown') {
      assertLocalWrite(request);
      sendJson(response, 200, { ok: true, message: 'CodeSwitchboard is stopping.' });
      setImmediate(() => {
        launcher.close();
        server.close();
      });
      return true;
    }

    const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
    if (providerMatch && request.method === 'PUT') {
      assertLocalWrite(request);
      const provider = configuredProvider(decodeURIComponent(providerMatch[1]));
      if (!provider) throw Object.assign(new Error('Unknown provider.'), { statusCode: 404 });
      const body = await readJson(request);
      if (typeof body.apiKey === 'string') {
        if (body.apiKey.trim()) {
          providerKeys.set(provider.id, body.apiKey.trim());
          persistentStore.setKey(provider.id, body.apiKey.trim());
          persistedKeyIds.add(provider.id);
        } else {
          providerKeys.delete(provider.id);
          persistentStore.setKey(provider.id, '');
          persistedKeyIds.delete(provider.id);
        }
      }
      if (provider.custom) {
        if (!body.baseUrl) throw Object.assign(new Error('A custom provider needs a base URL.'), { statusCode: 400 });
        try {
          const override = { baseUrl: normalizedBaseUrl(body.baseUrl) };
          providerOverrides.set(provider.id, override);
          persistentStore.setProviderOverride(provider.id, override);
        }
        catch (error) { throw Object.assign(new Error(error.message), { statusCode: 400 }); }
      }
      modelCache.delete(provider.id);
      const updated = configuredProvider(provider.id);
      sendJson(response, 200, { ok: true, provider: { id: updated.id, baseUrl: updated.baseUrl, keyConfigured: Boolean(keyFor(updated)) } });
      return true;
    }

    if (providerMatch && request.method === 'DELETE') {
      assertLocalWrite(request);
      const provider = configuredProvider(decodeURIComponent(providerMatch[1]));
      if (!provider) throw Object.assign(new Error('Unknown provider.'), { statusCode: 404 });
      providerKeys.delete(provider.id);
      persistentStore.setKey(provider.id, '');
      persistedKeyIds.delete(provider.id);
      modelCache.delete(provider.id);
      sendJson(response, 200, { ok: true, keyConfigured: Boolean(process.env[provider.env]), keySource: process.env[provider.env] ? 'environment' : null });
      return true;
    }

    if (request.method === 'PUT' && url.pathname === '/api/preferences') {
      assertLocalWrite(request);
      const body = await readJson(request);
      const allowed = Object.fromEntries(['providerId', 'targetId', 'model', 'workspace'].filter((key) => typeof body[key] === 'string').map((key) => [key, body[key].trim()]));
      persistentStore.updateSelections(allowed);
      sendJson(response, 200, { ok: true, preferences: persistentStore.selections() });
      return true;
    }

    const modelsMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/models$/);
    if (modelsMatch && request.method === 'GET') {
      const provider = configuredProvider(decodeURIComponent(modelsMatch[1]));
      if (!provider) throw Object.assign(new Error('Unknown provider.'), { statusCode: 404 });
      if (!provider.baseUrl) throw Object.assign(new Error('Set the custom provider base URL first.'), { statusCode: 400 });
      const apiKey = keyFor(provider);
      if (!apiKey) throw Object.assign(new Error(`Add a ${provider.name} API key first.`), { statusCode: 400 });
      const cached = modelCache.get(provider.id);
      if (cached && cached.baseUrl === provider.baseUrl && Date.now() - cached.loadedAt < 60_000) {
        sendJson(response, 200, { models: cached.models, cached: true });
        return true;
      }
      const models = await modelFetcher({ baseUrl: provider.baseUrl, apiKey });
      modelCache.set(provider.id, { models, baseUrl: provider.baseUrl, loadedAt: Date.now() });
      sendJson(response, 200, { models, cached: false });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/launch') {
      assertLocalWrite(request);
      const body = await readJson(request);
      const target = TARGETS.find((item) => item.id === body.targetId);
      if (!target) throw Object.assign(new Error('Choose a valid launch target.'), { statusCode: 400 });
      const provider = configuredProvider(body.providerId);
      const needsProvider = ['bridge', 'compatible', 'anthropic', 'gemini', 'app-gateway', 'gateway-compatible'].includes(target.routing);
      if (needsProvider && !provider) throw Object.assign(new Error('Choose a provider.'), { statusCode: 400 });
      if (needsProvider && !keyFor(provider)) throw Object.assign(new Error(`Add a ${provider.name} API key first.`), { statusCode: 400 });
      const model = String(body.model || '').trim();
      if (needsProvider && !model) throw Object.assign(new Error('Choose or enter a model.'), { statusCode: 400 });
      const workspace = path.resolve(String(body.workspace || process.cwd()));
      persistentStore.updateSelections({ providerId: body.providerId, targetId: target.id, model, workspace });
      const fallbackProvider = provider || configuredProvider('nvidia');
      console.log('[launch] starting', { target: target.id, provider: needsProvider ? provider.id : target.routing, workspace });
      let models = [model];
      if (needsProvider) {
        try {
          models = await modelsFor(provider);
          console.log('[launch] fetched', models.length, 'models from', provider.name, ':', models.slice(0, 5).join(', '), models.length > 5 ? '...' : '');
          // A provider's /models response is useful for discovery, but it is
          // not a complete authority: aliases, manually enabled deployments,
          // and newly released IDs are often omitted. Preserve the user's exact
          // selection and let the upstream return its actionable model error.
        }
        catch (error) {
          if (error.code === 'model-unavailable') throw error;
          console.warn('[launch] model catalog unavailable; launching with only the selected model.', { error: error.message });
        }
      }
      const result = await launcher.launch({
        targetId: target.id,
        provider: fallbackProvider,
        apiKey: needsProvider ? keyFor(provider) : '',
        model,
        models,
        localGatewayBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        workspace
      });
      console.log('[launch] started', { target: target.id, message: result.message });
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/test-target') {
      assertLocalWrite(request);
      const body = await readJson(request);
      const target = TARGETS.find((item) => item.id === body.targetId);
      if (!target) throw Object.assign(new Error('Choose a valid test target.'), { statusCode: 400 });
      const provider = configuredProvider(body.providerId);
      if (!provider) throw Object.assign(new Error('Choose a provider.'), { statusCode: 400 });
      const apiKey = keyFor(provider);
      if (!apiKey) throw Object.assign(new Error(`Add a ${provider.name} API key first.`), { statusCode: 400 });
      const model = String(body.model || '').trim();
      if (!model) throw Object.assign(new Error('Choose or enter a model.'), { statusCode: 400 });
      const workspace = path.resolve(String(body.workspace || process.cwd()));
      const prompt = String(body.prompt || 'Reply with exactly CODESWITCHBOARD_OK. Do not use tools.').trim();
      console.log('[test-target] starting', { target: target.id, provider: provider.id, model });
      let models = [model];
      try { models = await modelsFor(provider); }
      catch (error) { console.warn('[test-target] model catalog unavailable; testing with only the selected model.', { error: error.message }); }
      const result = await launcher.testMessage({ targetId: target.id, provider, apiKey, model, models, workspace, prompt, localGatewayBaseUrl: `http://127.0.0.1:${server.address().port}/v1` });
      persistentStore.setTargetVerification?.(target.id, {
        status: 'verified',
        scope: 'local-mock',
        testedAt: new Date().toISOString(),
        providerId: provider.id,
        model,
        inferenceRequests: result.inferenceRequests || 0
      });
      console.log('[test-target] passed', { target: target.id });
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/restore-codex') {
      assertLocalWrite(request);
      const result = spawnSync(process.execPath, [legacyLauncherPath, 'launch', 'codex-app', '--restore'], {
        encoding: 'utf8', windowsHide: true, timeout: 30_000
      });
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Could not restore Codex.').trim());
      sendJson(response, 200, { ok: true, message: result.stdout.trim() || 'Codex restored to its normal account configuration.' });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/restore-claude') {
      assertLocalWrite(request);
      const result = launcher.restoreClaudeDesktop();
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }

    return false;
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/v1/')) {
        await handleLocalGateway(request, response, url);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!await handleApi(request, response, url)) sendJson(response, 404, { error: 'API route not found.' });
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405).end('Method not allowed');
        return;
      }
      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const assetPath = path.resolve(publicDirectory, requested);
      const publicRoot = path.resolve(publicDirectory) + path.sep;
      if (!assetPath.startsWith(publicRoot) || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, {
        'content-type': MIME_TYPES[path.extname(assetPath)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY'
      });
      if (request.method === 'HEAD') response.end(); else fs.createReadStream(assetPath).pipe(response);
    } catch (error) {
      if (request.url?.startsWith('/api/launch')) console.error('[launch] failed', { error: error.message });
      if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.message, code: error.code || 'failed' });
      else response.end();
    }
  });

  return {
    server,
    listen(port = 4242) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address()));
      });
    },
    close() {
      launcher.close();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createControlServer, normalizedBaseUrl, assertLocalWrite };
