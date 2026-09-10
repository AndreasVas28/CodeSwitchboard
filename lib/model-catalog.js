'use strict';

const REASONING_LEVELS = [
  { effort: 'low', description: 'Low' },
  { effort: 'medium', description: 'Medium' },
  { effort: 'high', description: 'High' }
];

async function fetchModelIds({ baseUrl, apiKey, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) throw new Error(`Could not load provider models (${response.status}): ${await response.text()}`);
  const payload = await response.json();
  const modelIds = [...new Set((payload.data || []).map((model) => model?.id).filter((id) => typeof id === 'string' && id))].sort();
  if (!modelIds.length) throw new Error('The provider returned an empty model catalog.');
  return modelIds;
}

function createModelCatalog(modelIds, preferredModel) {
  const orderedIds = [...new Set(modelIds)].sort((left, right) => {
    if (left === preferredModel) return -1;
    if (right === preferredModel) return 1;
    return left.localeCompare(right);
  });
  return {
    models: orderedIds.map((modelId, priority) => ({
      slug: modelId,
      display_name: modelId,
      description: 'Available through the NVIDIA API catalog.',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: REASONING_LEVELS,
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      priority,
      base_instructions: 'You are Codex, a coding agent. Use the available tools to complete the user request.',
      supports_reasoning_summaries: false,
      support_verbosity: false,
      apply_patch_tool_type: 'freeform',
      web_search_tool_type: 'text',
      truncation_policy: { mode: 'tokens', limit: 10000 },
      supports_parallel_tool_calls: true,
      context_window: 131072,
      max_context_window: 131072,
      effective_context_window_percent: 90,
      experimental_supported_tools: [],
      input_modalities: ['text'],
      supports_search_tool: false,
      use_responses_lite: false
    }))
  };
}

module.exports = { fetchModelIds, createModelCatalog };
