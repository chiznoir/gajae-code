import { describe, expect, test } from "bun:test";
import { Effort, type Model } from "@gajae-code/ai";
import {
	resolveCliModel,
	resolveModelFromSettings,
	resolveModelOverride,
	resolveModelRoleValue,
	resolveModelScope,
	resolveSelector,
	restoreModelFromSession,
	splitSelectorThinkingSuffix,
} from "@gajae-code/coding-agent/config/model-resolver";
import { Settings } from "@gajae-code/coding-agent/config/settings";

const model = (provider: string, id: string): Model<"anthropic-messages"> => ({
	id,
	name: id,
	api: "anthropic-messages",
	provider,
	baseUrl: "https://example.test",
	reasoning: true,
	thinking: { mode: "budget", minLevel: Effort.Minimal, maxLevel: Effort.High },
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const candidates = [model("openai", "gpt"), model("openrouter", "z-ai/glm-4.7")];

const registry = {
	getAvailable: () => candidates,
	getAll: () => candidates,
	getCanonicalVariants: () => [],
	find: (provider: string, id: string) =>
		candidates.find(candidate => candidate.provider === provider && candidate.id === id),
	getApiKey: async () => "test-key",
};

describe("staged selector golden table", () => {
	test("documents case and suffix divergence", () => {
		const golden = [
			{ selector: "OPENAI/GPT", id: "gpt", thinkingLevel: undefined, explicit: false },
			{ selector: "openai/gpt:high", id: "gpt", thinkingLevel: Effort.High, explicit: true },
			// A second suffix is not recursively consumed by the staged resolver.
			{ selector: "openai/gpt:high:low", id: undefined, thinkingLevel: undefined, explicit: false },
		] as const;

		for (const expected of golden) {
			const resolved = resolveSelector(expected.selector, candidates);
			expect(resolved.model?.id).toBe(expected.id);
			expect(resolved.thinkingLevel).toBe(expected.thinkingLevel);
			expect(resolved.explicitThinkingLevel).toBe(expected.explicit);
		}
	});

	test("routes every resolver adapter through the staged selector", async () => {
		const settings = Settings.isolated({ modelRoles: { default: "openrouter/z-ai/glm-4.7" } });
		const adapters = [
			{
				name: "role",
				resolve: async () => resolveModelRoleValue("pi/default", candidates, { settings }).model,
			},
			{
				name: "override",
				resolve: async () => resolveModelOverride(["openrouter/z-ai/glm-4.7"], registry, settings).model,
			},
			{
				name: "settings",
				resolve: async () => resolveModelFromSettings({ settings, availableModels: candidates }),
			},
			{
				name: "session",
				resolve: async () =>
					(await restoreModelFromSession("openrouter", "z-ai/glm-4.7", undefined, false, registry)).model,
			},
			{
				name: "CLI provider",
				resolve: async () =>
					resolveCliModel({ cliProvider: "openrouter", cliModel: "z-ai/glm-4.7", modelRegistry: registry }).model,
			},
			{
				name: "CLI no provider",
				resolve: async () =>
					resolveCliModel({ cliModel: "openrouter/z-ai/glm-4.7", modelRegistry: registry }).model,
			},
			{
				name: "scope",
				resolve: async () => (await resolveModelScope(["openrouter/z-ai/glm-4.7"], registry))[0]?.model,
			},
		] as const;

		for (const adapter of adapters) {
			await expect(adapter.resolve(), adapter.name).resolves.toMatchObject({
				provider: "openrouter",
				id: "z-ai/glm-4.7",
			});
		}
	});

	test("preserves scope preferences and concrete OpenRouter route selectors", async () => {
		const openai = model("openai", "shared");
		const openrouter = model("openrouter", "shared");
		const routeBase = model("openrouter", "z-ai/glm-4.7");
		const scopedCandidates = [openai, openrouter, routeBase];
		const scopedRegistry = { getAvailable: () => scopedCandidates, getCanonicalVariants: () => [] };

		const preferred = await resolveModelScope(["shared"], scopedRegistry, {
			usageOrder: ["openrouter/shared"],
		});
		expect(preferred[0]?.model).toBe(openrouter);

		const route = await resolveModelScope(["openrouter/z-ai/glm-4.7-20251222:nitro"], scopedRegistry);
		expect(route[0]?.model).toMatchObject({ provider: "openrouter", id: "z-ai/glm-4.7-20251222:nitro" });
	});

	test("returns stable candidate identity across repeated memoized resolution", () => {
		const first = resolveSelector("openai/gpt", candidates).model;
		const second = resolveSelector("openai/gpt", candidates).model;
		expect(first).toBe(candidates[0]);
		expect(second).toBe(first);
	});

	test("case-only duplicate provider selectors fall through to bare-id ranking", () => {
		const duplicates = [model("openai", "gpt"), model("openai", "GPT")];
		expect(resolveSelector("openai/gpt", duplicates).model?.id).toBe("gpt");
	});

	test("splits only the final selector suffix", () => {
		expect(splitSelectorThinkingSuffix("openrouter/qwen/model:route:high")).toEqual({
			selector: "openrouter/qwen/model:route",
			thinkingLevel: Effort.High,
		});
	});
});
