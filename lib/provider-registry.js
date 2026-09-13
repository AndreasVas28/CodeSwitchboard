'use strict';

const PROVIDERS = [
  { id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', env: 'NVIDIA_API_KEY' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY' },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', env: 'TOGETHER_API_KEY' },
  { id: 'fireworks', name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', env: 'FIREWORKS_API_KEY' },
  { id: 'deepinfra', name: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', env: 'DEEPINFRA_API_KEY' },
  { id: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', env: 'CEREBRAS_API_KEY' },
  { id: 'sambanova', name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', env: 'SAMBANOVA_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', env: 'DEEPSEEK_API_KEY' },
  { id: 'mistral', name: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY' },
  { id: 'xai', name: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', env: 'XAI_API_KEY' },
  { id: 'moonshot', name: 'Moonshot AI (Kimi)', baseUrl: 'https://api.moonshot.ai/v1', env: 'MOONSHOT_API_KEY' },
  { id: 'siliconflow', name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.com/v1', env: 'SILICONFLOW_API_KEY' },
  { id: 'custom', name: 'Custom endpoint', baseUrl: '', env: 'CODESWITCHBOARD_API_KEY', custom: true }
];

function providerById(id) {
  return PROVIDERS.find((provider) => provider.id === id);
}

module.exports = { PROVIDERS, providerById };
