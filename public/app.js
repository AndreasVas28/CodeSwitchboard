'use strict';

const elements = {
  providerList: document.querySelector('#provider-list'),
  targetList: document.querySelector('#target-list'),
  targetCount: document.querySelector('#target-count'),
  navInstalledCount: document.querySelector('#nav-installed-count'),
  connectedCount: document.querySelector('#connected-count'),
  workspace: document.querySelector('#workspace'),
  refresh: document.querySelector('#refresh-state'),
  baseUrlField: document.querySelector('#base-url-field'),
  baseUrl: document.querySelector('#base-url'),
  apiKey: document.querySelector('#api-key'),
  toggleKey: document.querySelector('#toggle-key'),
  connect: document.querySelector('#connect-provider'),
  forget: document.querySelector('#forget-key'),
  keyBadge: document.querySelector('#key-badge'),
  providerConfigTitle: document.querySelector('#provider-config-title'),
  providerDescription: document.querySelector('#provider-description'),
  model: document.querySelector('#model'),
  modelPicker: document.querySelector('#model-picker'),
  modelOptions: document.querySelector('#model-options'),
  modelCount: document.querySelector('#model-count'),
  modelSwitchHelp: document.querySelector('#model-switch-help'),
  applyModel: document.querySelector('#apply-model'),
  routeProvider: document.querySelector('#route-provider'),
  routeTarget: document.querySelector('#route-target'),
  flowProvider: document.querySelector('#flow-provider'),
  flowTarget: document.querySelector('#flow-target'),
  flowRouting: document.querySelector('#flow-routing'),
  actionDot: document.querySelector('#action-dot'),
  actionTitle: document.querySelector('#action-title'),
  actionDetail: document.querySelector('#action-detail'),
  launch: document.querySelector('#launch'),
  testTarget: document.querySelector('#test-target'),
  restore: document.querySelector('#restore-codex'),
  restoreClaude: document.querySelector('#restore-claude'),
  activity: document.querySelector('#activity'),
  clearActivity: document.querySelector('#clear-activity')
};

let appState;
let selectedProviderId = 'nvidia';
let selectedTargetId = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function log(message, type = '') {
  const empty = elements.activity.querySelector('.empty-activity');
  if (empty) empty.remove();
  const item = document.createElement('li');
  item.className = type;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const text = document.createElement('span');
  text.textContent = message;
  item.append(time, text);
  elements.activity.prepend(item);
}

function provider() {
  return appState?.providers.find((item) => item.id === selectedProviderId);
}

function target() {
  return appState?.targets.find((item) => item.id === selectedTargetId);
}

function savePreferences(values) {
  api('/api/preferences', { method: 'PUT', body: JSON.stringify(values) }).catch((error) => log(`Could not save selection: ${error.message}`, 'error'));
}

function renderProviders() {
  elements.providerList.replaceChildren();
  const connected = appState.providers.filter((item) => item.keyConfigured).length;
  elements.connectedCount.textContent = `${connected}/${appState.providers.length} connected`;
  for (const item of appState.providers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `provider-button${item.id === selectedProviderId ? ' selected' : ''}`;
    button.dataset.providerId = item.id;
    const icon = document.createElement('span');
    icon.className = 'provider-icon';
    icon.textContent = item.custom ? '+': item.name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = item.name;
    const dot = document.createElement('span');
    dot.className = `status-dot${item.keyConfigured ? ' connected' : ''}`;
    button.append(icon, name, dot);
    button.addEventListener('click', () => selectProvider(item.id));
    elements.providerList.append(button);
  }
}

function renderProviderDetails() {
  const item = provider();
  if (!item) return;
  elements.providerDescription.textContent = item.custom ? 'Connect any OpenAI-compatible endpoint.' : item.baseUrl;
  elements.providerConfigTitle.textContent = `${item.name} connection`;
  elements.baseUrlField.classList.toggle('hidden', !item.custom);
  elements.baseUrl.value = item.custom ? item.baseUrl : '';
  elements.apiKey.value = '';
  elements.apiKey.placeholder = item.keyConfigured ? `Key active from ${item.keySource}` : 'Paste a key for this session';
  elements.keyBadge.textContent = item.keyConfigured ? `Connected · ${item.keySource}` : 'No key';
  elements.keyBadge.classList.toggle('good', item.keyConfigured);
  elements.routeProvider.textContent = item.name;
  elements.flowProvider.textContent = item.name;
  updateLaunchState();
}

function clearModelCatalog(message = 'Choose an available model or type an exact model ID.') {
  elements.modelPicker.replaceChildren();
  const option = document.createElement('option');
  option.value = '';
  option.textContent = message;
  elements.modelPicker.append(option);
  elements.modelOptions.replaceChildren();
  elements.modelCount.textContent = message;
}

function selectProvider(id) {
  selectedProviderId = id;
  elements.model.value = '';
  clearModelCatalog('Connect to load models, or type an exact model ID.');
  renderProviders();
  renderProviderDetails();
  savePreferences({ providerId: id });
  if (provider().keyConfigured && provider().baseUrl) loadModels();
}

function renderTargets() {
  elements.targetList.replaceChildren();
  const items = appState.catalog || appState.targets;
  const installed = items.filter((item) => item.installed).length;
  elements.targetCount.textContent = `${installed}/${items.length} installed · complete catalog`;
  elements.navInstalledCount.textContent = installed;
  for (const item of items) {
    const launchTarget = appState.targets.find((targetItem) => targetItem.id === item.id);
    const selectable = Boolean(item.installed && launchTarget && (launchTarget.launchable !== false));
    const card = document.createElement('article');
    card.className = `target-card${item.id === selectedTargetId ? ' selected' : ''}${selectable || item.installable ? '' : ' unavailable'}`;
    if (selectable || item.installable) {
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
    }

    const top = document.createElement('div');
    top.className = 'target-top';
    const name = document.createElement('span');
    name.className = 'target-name'; name.textContent = item.name;
    const kind = document.createElement('span');
    kind.className = 'target-kind'; kind.textContent = item.surface || item.kind;
    top.append(name, kind);

    const description = document.createElement('p');
    description.textContent = launchTarget?.description || `${item.mode} · ${item.windows} Windows support · adapter ${item.implementation}`;
    const meta = document.createElement('div');
    meta.className = 'target-meta';
    const availability = document.createElement('span');
    availability.className = item.installed ? 'installed' : 'missing';
    availability.textContent = item.installed ? `● Installed · ${item.verificationStatus || 'unverified'}` : item.installable ? '↓ Click to install' : '○ Manual setup';
    const routing = document.createElement('span');
    routing.className = 'routing'; routing.textContent = launchTarget?.modelCommand ? `Switch: ${launchTarget.modelCommand} · ${item.verificationStatus || 'unverified'}` : item.mode;
    meta.append(availability, routing);

    const officialLink = document.createElement('a');
    officialLink.className = 'official-link';
    officialLink.href = item.homepage || item.docs;
    officialLink.target = '_blank';
    officialLink.rel = 'noopener noreferrer';
    officialLink.textContent = item.installable ? 'Official website / download ↗' : 'Official website ↗';
    officialLink.addEventListener('click', (event) => event.stopPropagation());

    card.append(top, description, meta, officialLink);
    if (selectable) {
      const choose = () => selectTarget(item.id);
      card.addEventListener('click', choose);
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
      });
    } else if (!item.installed && item.installable) {
      const install = () => installCatalogTarget(item);
      card.addEventListener('click', install);
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); install(); }
      });
    }
    elements.targetList.append(card);
  }
}

async function installCatalogTarget(item) {
  if (!confirm(`Install ${item.name} from its official ${item.install?.[0]?.type || 'package'} source?`)) return;
  log(`Installing ${item.name}…`);
  try {
    const result = await api(`/api/targets/${encodeURIComponent(item.id)}/install`, { method: 'POST', body: '{}' });
    log(`${item.name} ${result.receipt.status}${result.receipt.version ? ` · ${result.receipt.version}` : ''}.`, 'success');
    await refreshState();
  } catch (error) { log(`${item.name} installation failed: ${error.message}`, 'error'); }
}

function selectTarget(id) {
  selectedTargetId = id;
  renderTargets();
  elements.routeTarget.textContent = target().name;
  elements.flowTarget.textContent = target().name;
  elements.flowRouting.textContent = target().routingLabel;
  const needsModel = ['bridge', 'compatible', 'anthropic', 'gemini', 'app-gateway', 'gateway-compatible'].includes(target().routing);
  elements.model.disabled = !needsModel;
  if (!needsModel) elements.model.placeholder = target().routing === 'native' ? 'Uses tool account' : target().routing === 'account' ? 'Vendor login required' : 'Managed by editor';
  else elements.model.placeholder = 'Select or type a model ID';
  const switchHelp = target().modelSwitch || target().modelCommand;
  elements.modelSwitchHelp.textContent = switchHelp ? `After launch: ${switchHelp}. Changing this selection here affects the next launch.` : 'Changing this selection affects the next launch.';
  elements.applyModel.disabled = !needsModel;
  updateLaunchState();
  savePreferences({ targetId: id });
  if (needsModel && !provider()?.keyConfigured) showView('providers');
  else showView('launch');
}

function updateLaunchState() {
  const selected = target();
  if (!selected || !selected.installed) {
    elements.modelPicker.disabled = true;
    elements.model.disabled = true;
    elements.applyModel.disabled = true;
    elements.launch.disabled = true;
    elements.actionDot.classList.remove('ready');
    elements.actionTitle.textContent = 'Choose a launch target';
    elements.actionDetail.textContent = 'Configuration is incomplete';
    return;
  }
  const needsProvider = ['bridge', 'compatible', 'anthropic', 'gemini', 'app-gateway', 'gateway-compatible'].includes(selected.routing);
  elements.modelPicker.disabled = !needsProvider;
  elements.model.disabled = !needsProvider;
  const ready = !needsProvider || (provider()?.keyConfigured && elements.model.value.trim());
  const testable = ['opencode-cli', 'aider-cli', 'claude-cli', 'pi-cli', 'cline-cli', 'dsh-cli', 'hermes-cli', 'gemini-cli', 'crush-cli', 'qwen-cli', 'kilo-cli'].includes(selected.id);
  elements.testTarget.hidden = !testable;
  elements.testTarget.disabled = !ready;
  elements.launch.disabled = false;
  elements.launch.querySelector('span').textContent = ready ? 'Launch selected tool' : 'Configure selected tool';
  elements.actionDot.classList.toggle('ready', Boolean(ready));
  elements.actionTitle.textContent = ready ? `Ready to launch ${selected.name}` : `Finish configuring ${selected.name}`;
  elements.actionDetail.textContent = ready
    ? (needsProvider ? `${provider().name} · ${elements.model.value.trim()} · ${selected.modelSwitch || selected.modelCommand || 'use the app picker'}` : selected.routingLabel)
    : (!provider()?.keyConfigured ? 'Connect the selected provider' : 'Choose or enter a model');
}

function recommendedModel(models, providerId) {
  if (!models.length) return '';
  const providerPreferences = {
    nvidia: [
      /^poolside\/laguna-xs-2\.1$/i,
      /^deepseek-ai\/deepseek-v4-pro/i,
      /^nvidia\/nemotron-3-super/i
    ]
  };
  const generalPreferences = [
    /(?:^|\/)(?:qwen[^/]*coder|coder|code|devstral)/i,
    /deepseek/i,
    /nemotron/i
  ];
  for (const pattern of [...(providerPreferences[providerId] || []), ...generalPreferences]) {
    const match = models.find((model) => pattern.test(model));
    if (match) return match;
  }
  return models[0];
}

async function loadModels() {
  const item = provider();
  if (!item?.keyConfigured || !item.baseUrl) return;
  elements.modelCount.textContent = 'Loading model catalog…';
  try {
    const result = await api(`/api/providers/${encodeURIComponent(item.id)}/models`);
    elements.modelPicker.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a model from the live catalog';
    elements.modelPicker.append(placeholder);
    elements.modelOptions.replaceChildren();
    for (const model of result.models) {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      elements.modelPicker.append(option);
      const datalistOption = document.createElement('option');
      datalistOption.value = model;
      elements.modelOptions.append(datalistOption);
    }
    elements.modelCount.textContent = `${result.models.length.toLocaleString()} models available · exact IDs also accepted.`;
    if (elements.model.value.trim()) elements.modelPicker.value = elements.model.value.trim();
    if (!elements.model.value.trim() && result.models.length) {
      elements.model.value = recommendedModel(result.models, item.id);
      savePreferences({ model: elements.model.value });
    }
    log(`Loaded ${result.models.length} models from ${item.name}.`, 'success');
    updateLaunchState();
  } catch (error) {
    elements.modelCount.textContent = error.message;
    log(error.message, 'error');
  }
}

async function refreshState({ initial = false } = {}) {
  try {
    const previousWorkspace = elements.workspace.value;
    appState = await api('/api/state');
    const saved = appState.preferences || {};
    if (initial && appState.providers.some((item) => item.id === saved.providerId)) selectedProviderId = saved.providerId;
    if (!appState.providers.some((item) => item.id === selectedProviderId)) selectedProviderId = appState.providers[0].id;
    if (!elements.workspace.value || initial) elements.workspace.value = previousWorkspace || saved.workspace || appState.workspace;
    if (initial && appState.targets.find((item) => item.id === saved.targetId)?.installed) selectedTargetId = saved.targetId;
    if (initial && saved.model) elements.model.value = saved.model;
    if (selectedTargetId && !appState.targets.find((item) => item.id === selectedTargetId)?.installed) selectedTargetId = null;
    renderProviders();
    renderProviderDetails();
    renderTargets();
    if (!selectedTargetId) {
      elements.routeTarget.textContent = 'Choose a target';
      elements.flowTarget.textContent = 'Select an app';
      elements.flowRouting.textContent = 'Waiting for target';
      elements.model.disabled = true;
    }
    if (!initial) log('Rescanned installed coding tools.');
    if (provider().keyConfigured && provider().baseUrl) loadModels();
  } catch (error) { log(error.message, 'error'); }
}

elements.connect.addEventListener('click', async () => {
  const item = provider();
  const payload = {};
  if (elements.apiKey.value.trim()) payload.apiKey = elements.apiKey.value.trim();
  if (item.custom) payload.baseUrl = elements.baseUrl.value.trim();
  elements.connect.disabled = true;
  elements.connect.textContent = 'Connecting…';
  try {
    await api(`/api/providers/${encodeURIComponent(item.id)}`, { method: 'PUT', body: JSON.stringify(payload) });
    appState = await api('/api/state');
    renderProviders(); renderProviderDetails();
    log(`${item.name} connected and encrypted on this PC.`, 'success');
    await loadModels();
    if (selectedTargetId) showView('launch');
  } catch (error) { log(error.message, 'error'); }
  finally { elements.connect.disabled = false; elements.connect.textContent = 'Connect & load models'; }
});

elements.forget.addEventListener('click', async () => {
  try {
    await api(`/api/providers/${encodeURIComponent(selectedProviderId)}`, { method: 'DELETE' });
    appState = await api('/api/state');    elements.model.value = '';
    clearModelCatalog();
    renderProviders(); renderProviderDetails();
    log(`Removed the saved ${provider().name} key.`);
  } catch (error) { log(error.message, 'error'); }
});

elements.launch.addEventListener('click', async () => {
  const selected = target();
  const needsProvider = ['bridge', 'compatible', 'anthropic', 'gemini', 'app-gateway', 'gateway-compatible'].includes(selected?.routing);
  if (needsProvider && !provider()?.keyConfigured) {
    showView('providers');
    log(`Connect ${provider().name} before launching ${selected.name}.`);
    return;
  }
  if (needsProvider && !elements.model.value.trim()) {
    showView('launch');
    await loadModels();
    if (!elements.model.value.trim()) log('Choose a model before launching.', 'error');
    return;
  }
  elements.launch.disabled = true;
  elements.launch.querySelector('span').textContent = 'Launching…';
  try {
    const result = await api('/api/launch', {
      method: 'POST',
      body: JSON.stringify({
        providerId: selectedProviderId,
        targetId: selectedTargetId,
        model: elements.model.value.trim(),
        workspace: elements.workspace.value.trim()
      })
    });
    log(result.message, 'success');
  } catch (error) { log(error.message, 'error'); }
  finally { elements.launch.querySelector('span').textContent = 'Launch selected tool'; updateLaunchState(); }
});

elements.testTarget.addEventListener('click', async () => {
  const selected = target();
  elements.testTarget.disabled = true;
  elements.testTarget.textContent = 'Testing…';
  try {
    const result = await api('/api/test-target', {
      method: 'POST',
      body: JSON.stringify({
        providerId: selectedProviderId,
        targetId: selectedTargetId,
        model: elements.model.value.trim(),
        workspace: elements.workspace.value.trim(),
        prompt: `Reply with exactly CODESWITCHBOARD_OK. Do not use tools.`
      })
    });
    const confirmed = /CODESWITCHBOARD_OK/.test(result.output);
    log(`${selected.name} test ${confirmed ? 'passed' : 'returned a response'}: ${result.output.slice(-240)}`, confirmed ? 'success' : '');
  } catch (error) { log(`${selected.name} test failed: ${error.message}`, 'error'); }
  finally { elements.testTarget.textContent = 'Send test message'; updateLaunchState(); }
});

elements.restore.addEventListener('click', async () => {
  elements.restore.disabled = true;
  try {
    const result = await api('/api/restore-codex', { method: 'POST', body: '{}' });
    log(result.message, 'success');
  } catch (error) { log(error.message, 'error'); }
  finally { elements.restore.disabled = false; }
});

elements.restoreClaude.addEventListener('click', async () => {
  elements.restoreClaude.disabled = true;
  try {
    const result = await api('/api/restore-claude', { method: 'POST', body: '{}' });
    log(result.message, 'success');
  } catch (error) { log(error.message, 'error'); }
  finally { elements.restoreClaude.disabled = false; }
});

elements.toggleKey.addEventListener('click', () => {
  const show = elements.apiKey.type === 'password';
  elements.apiKey.type = show ? 'text' : 'password';
  elements.toggleKey.textContent = show ? 'Hide' : 'Show';
  elements.toggleKey.setAttribute('aria-label', show ? 'Hide key' : 'Show key');
});
elements.model.addEventListener('input', () => {
  elements.modelPicker.value = elements.model.value.trim();
  updateLaunchState();
});
elements.model.addEventListener('change', () => savePreferences({ model: elements.model.value.trim() }));
elements.modelPicker.addEventListener('change', () => {
  if (!elements.modelPicker.value) return;
  elements.model.value = elements.modelPicker.value;
  updateLaunchState();
});
elements.applyModel.addEventListener('click', () => {
  const value = elements.model.value.trim();
  if (!value) {
    log('Choose or enter a model before applying it.', 'error');
    return;
  }
  elements.model.value = value;
  elements.modelPicker.value = value;
  savePreferences({ model: value });
  updateLaunchState();
  log(`Model applied for the next ${target()?.name || 'launch'}: ${value}.`, 'success');
});
elements.workspace.addEventListener('change', () => savePreferences({ workspace: elements.workspace.value.trim() }));
elements.model.addEventListener('change', updateLaunchState);
elements.refresh.addEventListener('click', () => refreshState());
elements.clearActivity.addEventListener('click', () => {
  elements.activity.replaceChildren();
  const empty = document.createElement('li'); empty.className = 'empty-activity'; empty.textContent = 'No activity in this session.';
  elements.activity.append(empty);
});

function showView(view) {
  for (const page of document.querySelectorAll('[data-page]')) {
    const active = page.dataset.page === view;
    page.hidden = !active;
    page.classList.toggle('active', active);
  }
  for (const button of document.querySelectorAll('[data-view]')) button.classList.toggle('active', button.dataset.view === view);
  if (history.replaceState) history.replaceState(null, '', `#${view}`);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view));
for (const button of document.querySelectorAll('[data-open-view]')) button.addEventListener('click', () => showView(button.dataset.openView));

elements.clearActivity.click();
showView(['launch', 'providers', 'targets', 'activity'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'launch');
refreshState({ initial: true });
