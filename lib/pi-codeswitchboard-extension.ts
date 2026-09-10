import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function codeswitchboard(pi: ExtensionAPI): Promise<void> {
  const baseUrl = process.env.CODESWITCHBOARD_PI_BASE_URL?.trim();
  const model = process.env.CODESWITCHBOARD_PI_MODEL?.trim();
  if (!baseUrl || !model) throw new Error("CodeSwitchboard Pi routing environment is incomplete.");
  let models: string[] = [model];
  try {
    const parsed = JSON.parse(process.env.CODESWITCHBOARD_PI_MODELS || "[]");
    if (Array.isArray(parsed)) models = [...new Set([...parsed.filter((id): id is string => typeof id === "string" && Boolean(id.trim())), model])];
  } catch { /* Keep the selected model if the optional catalog is malformed. */ }
  pi.registerProvider("codeswitchboard", {
    name: "CodeSwitchboard",
    baseUrl,
    apiKey: "$CODESWITCHBOARD_PI_TOKEN",
    authHeader: true,
    api: "anthropic-messages",
    models: models.map((id) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    })),
  });
  pi.registerCommand("models", {
    description: "Choose a CodeSwitchboard model",
    handler: async (_args, ctx) => {
      const choices = ctx.modelRegistry.getAvailable().filter((item) => item.provider === "codeswitchboard");
      const selected = await ctx.ui.select("CodeSwitchboard models", choices.map((item) => item.id));
      if (!selected) return;
      const next = choices.find((item) => item.id === selected);
      if (!next || !(await pi.setModel(next))) ctx.ui.notify(`Could not switch to ${selected}`, "error");
      else ctx.ui.notify(`Switched to ${selected}`, "info");
    },
  });
}
