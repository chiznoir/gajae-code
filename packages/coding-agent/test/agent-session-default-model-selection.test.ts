import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorageWriter,
	type SessionStorageWriterOpenOptions,
} from "@gajae-code/coding-agent/session/session-storage";
import { logger } from "@gajae-code/utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const INITIAL_MODEL: Model = {
	id: "initial",
	name: "Initial",
	api: "anthropic-messages",
	provider: "initial-provider",
	baseUrl: "https://example.invalid",
	reasoning: true,
	thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 2_048,
};

function targetModel(options?: { reasoning?: boolean; minLevel?: Effort; maxLevel?: Effort }): Model {
	return {
		...INITIAL_MODEL,
		id: options?.reasoning === false ? "plain" : "reasoning",
		name: "Target",
		provider: "target-provider",
		reasoning: options?.reasoning ?? true,
		thinking:
			options?.reasoning === false
				? undefined
				: { mode: "effort", minLevel: options?.minLevel ?? Effort.Low, maxLevel: options?.maxLevel ?? Effort.High },
	};
}

class AppendWriterTrackingStorage extends MemorySessionStorage {
	readonly #appendWriterStates: { closed: boolean }[] = [];

	get openAppendWriterCount(): number {
		return this.#appendWriterStates.filter(state => !state.closed).length;
	}

	override openWriter(filePath: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		const writer = super.openWriter(filePath, options);
		if (options?.flags === "w") return writer;
		const state = { closed: false };
		this.#appendWriterStates.push(state);
		return {
			writeLine: line => writer.writeLine(line),
			writeLineSync: line => writer.writeLineSync(line),
			flush: () => writer.flush(),
			fsync: () => writer.fsync(),
			async close(): Promise<void> {
				await writer.close();
				state.closed = true;
			},
			closeSync(): void {
				writer.closeSync();
				state.closed = true;
			},
			getError: () => writer.getError(),
			getCloseState: () => writer.getCloseState(),
			getCloseError: () => writer.getCloseError(),
		};
	}
}

describe("AgentSession durable default model selection", () => {
	let tempRoot: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settings: Settings;
	let activeStream: AssistantMessageEventStream | undefined;
	let streamCreated: PromiseWithResolvers<void>;

	beforeEach(async () => {
		streamCreated = Promise.withResolvers<void>();
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-default-model-session-"));
		authStorage = await AuthStorage.create(path.join(tempRoot, "auth.db"));
		authStorage.setRuntimeApiKey(INITIAL_MODEL.provider, "initial-key");
		authStorage.setRuntimeApiKey("target-provider", "target-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempRoot, "models.yml"));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				activeStream = new AssistantMessageEventStream();
				streamCreated.resolve();
				return activeStream;
			},
		});
		sessionManager = SessionManager.inMemory(tempRoot);
		settings = Settings.isolated({ defaultThinkingLevel: Effort.XHigh });
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		sessionManager.appendMessage({ role: "user", content: "existing transcript", timestamp: Date.now() });
	});

	afterEach(async () => {
		if (activeStream) {
			const message = createAssistantMessage("released during cleanup");
			activeStream.push({ type: "done", reason: "stop", message });
			activeStream.end(message);
			activeStream = undefined;
		}
		await session.dispose();
		authStorage.close();
		vi.restoreAllMocks();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("waits for an in-flight response before any durable or session mutation", async () => {
		// Given
		const model = targetModel({ minLevel: Effort.Medium, maxLevel: Effort.High });
		const preflightComplete = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (...args) => {
			const apiKey = await originalGetApiKey(...args);
			preflightComplete.resolve();
			return apiKey;
		});
		const prompt = session.prompt("in flight");
		await streamCreated.promise;
		const entriesBeforeSelection = sessionManager.getEntries();
		const idleBarrierEntered = Promise.withResolvers<"idle">();
		const originalWaitForIdle = session.waitForIdle.bind(session);
		vi.spyOn(session, "waitForIdle").mockImplementation(async () => {
			idleBarrierEntered.resolve("idle");
			await originalWaitForIdle();
		});
		const durableAttempted = Promise.withResolvers<"durable">();
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		const durableCommit = vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (...args) => {
			durableAttempted.resolve("durable");
			await originalDurableCommit(...args);
		});

		// When
		const selection = session.setDefaultModelSelection(model, Effort.XHigh);
		await preflightComplete.promise;
		const firstMutationBoundary = await Promise.race([idleBarrierEntered.promise, durableAttempted.promise]);
		const durableCallsBeforeIdle = durableCommit.mock.calls.length;
		const modelBeforeIdle = session.model;
		const entriesWhileStreaming = sessionManager.getEntries();

		// Then
		const message = createAssistantMessage("complete");
		activeStream?.push({ type: "done", reason: "stop", message });
		activeStream?.end(message);
		activeStream = undefined;
		await prompt;
		const result = await selection;
		expect(firstMutationBoundary).toBe("idle");
		expect(durableCallsBeforeIdle).toBe(0);
		expect(modelBeforeIdle).toBe(INITIAL_MODEL);
		expect(entriesWhileStreaming).toEqual(entriesBeforeSelection);
		expect(result).toEqual({
			provider: "target-provider",
			modelId: "reasoning",
			thinkingLevel: Effort.High,
		});
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(Effort.High);
		const entriesAfterSelection = sessionManager.getEntries();
		expect(entriesAfterSelection.slice(0, entriesBeforeSelection.length)).toEqual(entriesBeforeSelection);
		expect(entriesAfterSelection.filter(entry => entry.type === "model_change" && entry.role === "default")).toEqual([
			expect.objectContaining({ model: "target-provider/reasoning" }),
		]);
		expect(entriesAfterSelection.filter(entry => entry.type === "thinking_level_change")).toEqual([
			expect.objectContaining({ thinkingLevel: Effort.High }),
		]);
		const completedAssistantIndex = entriesAfterSelection.findIndex(
			(entry, index) =>
				index >= entriesBeforeSelection.length && entry.type === "message" && entry.message.role === "assistant",
		);
		const defaultModelMarkerIndex = entriesAfterSelection.findIndex(
			entry => entry.type === "model_change" && entry.role === "default",
		);
		const thinkingMarkerIndex = entriesAfterSelection.findIndex(entry => entry.type === "thinking_level_change");
		expect(completedAssistantIndex).toBeGreaterThanOrEqual(entriesBeforeSelection.length);
		expect(thinkingMarkerIndex).toBeGreaterThan(completedAssistantIndex);
		expect(defaultModelMarkerIndex).toBeGreaterThan(thinkingMarkerIndex);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/reasoning:high" });
	});

	it("preserves explicit off for a reasoning model", async () => {
		// Given
		const model = targetModel();
		session.setThinkingLevel(ThinkingLevel.Off);
		const entriesBeforeSelection = sessionManager.getEntries();

		// When
		const result = await session.setDefaultModelSelection(model, ThinkingLevel.Off);

		// Then
		expect(result.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Off);
		const selectionEntries = sessionManager.getEntries().slice(entriesBeforeSelection.length);
		expect(selectionEntries.filter(entry => entry.type === "model_change" && entry.role === "default")).toEqual([
			expect.objectContaining({ model: "target-provider/reasoning" }),
		]);
		expect(selectionEntries.filter(entry => entry.type === "thinking_level_change")).toEqual([
			expect.objectContaining({ thinkingLevel: ThinkingLevel.Off }),
		]);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/reasoning:off" });
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.XHigh);
	});

	it("restores an unchanged explicit default thinking level on resume", async () => {
		// Given
		modelRegistry.registerProvider("target-provider", {
			baseUrl: "https://example.invalid/v1",
			apiKey: "resume-key",
			api: "openai-completions",
			models: [targetModel()],
		});
		const model = modelRegistry.find("target-provider", "reasoning");
		if (!model) throw new Error("Expected registered resume model");
		const sourceManager = SessionManager.create(tempRoot, tempRoot);
		const sourceSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: sourceManager,
			settings,
			modelRegistry,
			thinkingLevel: ThinkingLevel.Off,
		});
		const resumedSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: SessionManager.create(tempRoot, tempRoot),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});

		try {
			const sourceSessionFile = sourceSession.sessionFile;
			if (!sourceSessionFile) throw new Error("Expected persisted source session");

			// When
			await sourceSession.setDefaultModelSelection(model, ThinkingLevel.Off);
			await sourceManager.rewriteEntries();
			expect(await resumedSession.switchSession(sourceSessionFile)).toBe(true);

			// Then
			expect(resumedSession.model?.provider).toBe(model.provider);
			expect(resumedSession.model?.id).toBe(model.id);
			expect(resumedSession.thinkingLevel).toBe(ThinkingLevel.Off);
		} finally {
			await sourceSession.dispose();
			await resumedSession.dispose();
		}
	});

	it("normalizes an unspecified level to off for a non-reasoning model", async () => {
		// Given
		const model = targetModel({ reasoning: false });

		// When
		const result = await session.setDefaultModelSelection(model, undefined);

		// Then
		expect(result.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/plain:off" });
	});

	it("serializes concurrent selections so the FIFO last request owns durable, live, and resume defaults", async () => {
		// Given
		const firstModel = { ...targetModel(), id: "first" };
		const lastModel = { ...targetModel(), id: "last" };
		const firstLiveApplyEntered = Promise.withResolvers<void>();
		const releaseFirstLiveApply = Promise.withResolvers<void>();
		const originalLiveApply = session.setModelTemporary.bind(session);
		vi.spyOn(session, "setModelTemporary").mockImplementation(async (model, thinkingLevel, options) => {
			if (model.id === firstModel.id) {
				firstLiveApplyEntered.resolve();
				await releaseFirstLiveApply.promise;
			}
			await originalLiveApply(model, thinkingLevel, options);
		});
		const lastPreflightEntered = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model.id === lastModel.id) lastPreflightEntered.resolve();
			return originalGetApiKey(model, ...args);
		});

		// When
		const firstSelection = session.setDefaultModelSelection(firstModel, Effort.Low);
		await firstLiveApplyEntered.promise;
		const lastSelection = session.setDefaultModelSelection(lastModel, Effort.High);
		const preflightRace = Promise.withResolvers<boolean>();
		void lastPreflightEntered.promise.then(() => preflightRace.resolve(true));
		setImmediate(() => preflightRace.resolve(false));
		const lastRequestOvertookFirst = await preflightRace.promise;
		if (lastRequestOvertookFirst) await lastSelection;
		releaseFirstLiveApply.resolve();
		await Promise.all([firstSelection, lastSelection]);

		// Then
		expect(lastRequestOvertookFirst).toBeFalse();
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/last:high" });
		expect(session.model).toBe(lastModel);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(sessionManager.buildSessionContext().models.default).toBe("target-provider/last");
	});

	it("rejects inherit before settings or session mutation", async () => {
		// Given
		const entriesBefore = sessionManager.getEntries();

		// When
		const selection = session.setDefaultModelSelection(targetModel(), ThinkingLevel.Inherit);

		// Then
		await expect(selection).rejects.toThrow(/inherit/i);
		expect(settings.getGlobal("modelRoles")).toBeUndefined();
		expect(session.model).toBe(INITIAL_MODEL);
		expect(sessionManager.getEntries()).toEqual(entriesBefore);
	});

	it("rejects missing credentials before waiting or mutation", async () => {
		// Given
		const waitForIdle = vi.spyOn(session, "waitForIdle");
		const entriesBefore = sessionManager.getEntries();
		const model = { ...targetModel(), provider: "missing-provider" };

		// When
		const selection = session.setDefaultModelSelection(model, Effort.Medium);

		// Then
		await expect(selection).rejects.toThrow("No API key for missing-provider/reasoning");
		expect(waitForIdle).not.toHaveBeenCalled();
		expect(settings.getGlobal("modelRoles")).toBeUndefined();
		expect(sessionManager.getEntries()).toEqual(entriesBefore);
	});

	it("does not apply the live selection when the durable commit fails", async () => {
		// Given
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockRejectedValue(new Error("durable write failed"));
		const liveApply = vi.spyOn(session, "setModelTemporary");

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.Medium);

		// Then
		await expect(selection).rejects.toThrow("durable write failed");
		expect(liveApply).not.toHaveBeenCalled();
		expect(session.model).toBe(INITIAL_MODEL);
	});

	it("does not restore live state when durable default persistence fails", async () => {
		// Given
		const priorModelRoles = { default: "initial-provider/initial:low", planner: "planner/model:medium" };
		const durableError = new Error("durable write failed");
		settings.set("modelRoles", priorModelRoles);
		const entriesBeforeSelection = sessionManager.getEntries();
		const contextBeforeSelection = sessionManager.buildSessionContext();
		const priorModel = session.model;
		const priorThinkingLevel = session.thinkingLevel;
		const setModel = vi.spyOn(session.agent, "setModel");
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockRejectedValue(durableError);

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toBe(durableError);
		expect(setModel).not.toHaveBeenCalled();
		expect(settings.getGlobal("modelRoles")).toEqual(priorModelRoles);
		expect(session.model).toBe(priorModel);
		expect(session.thinkingLevel).toBe(priorThinkingLevel);
		expect(sessionManager.getEntries()).toEqual(entriesBeforeSelection);
		expect(sessionManager.buildSessionContext()).toEqual(contextBeforeSelection);
	});

	it("continues the selection queue after a rejected operation", async () => {
		// Given
		const successfulModel = { ...targetModel(), id: "after-failure" };
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush")
			.mockImplementation(originalDurableCommit)
			.mockRejectedValueOnce(new Error("durable write failed"));

		// When
		const failedSelection = session.setDefaultModelSelection(targetModel(), Effort.Low);
		await expect(failedSelection).rejects.toThrow("durable write failed");
		const successfulSelection = await session.setDefaultModelSelection(successfulModel, Effort.High);

		// Then
		expect(successfulSelection).toEqual({
			provider: "target-provider",
			modelId: "after-failure",
			thinkingLevel: Effort.High,
		});
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/after-failure:high" });
		expect(session.model).toBe(successfulModel);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(sessionManager.buildSessionContext().models.default).toBe("target-provider/after-failure");
	});

	it("restores the prior durable and live selection when the target live apply fails late", async () => {
		// Given
		const priorModelRoles = { default: "initial-provider/initial:low", planner: "planner/model:medium" };
		const priorLiveModel = session.model;
		const priorThinkingLevel = session.thinkingLevel;
		const model = targetModel();
		const lateLiveApplyError = new Error("late live apply failure");
		settings.set("modelRoles", priorModelRoles);
		const originalLiveApply = session.setModelTemporary.bind(session);
		vi.spyOn(session, "setModelTemporary").mockImplementationOnce(async (...args) => {
			await originalLiveApply(...args);
			throw lateLiveApplyError;
		});

		// When
		const selection = session.setDefaultModelSelection(model, Effort.High);

		// Then
		await expect(selection).rejects.toBe(lateLiveApplyError);
		expect(settings.getGlobal("modelRoles")).toEqual(priorModelRoles);
		expect(session.model).toBe(priorLiveModel);
		expect(session.thinkingLevel).toBe(priorThinkingLevel);
	});

	it("restores the exact prior model when the failed target shares its selector but changes API metadata", async () => {
		// Given
		const priorLiveModel = session.model;
		if (!priorLiveModel) throw new Error("Expected initial live model");
		const targetWithDifferentApi: Model = {
			...priorLiveModel,
			api: "openai-completions",
			baseUrl: "https://replacement.example.invalid/v1",
		};
		const lateLiveApplyError = new Error("late live apply failure");
		const originalLiveApply = session.setModelTemporary.bind(session);
		vi.spyOn(session, "setModelTemporary").mockImplementationOnce(async (...args) => {
			await originalLiveApply(...args);
			throw lateLiveApplyError;
		});

		// When
		const selection = session.setDefaultModelSelection(targetWithDifferentApi, Effort.High);

		// Then
		await expect(selection).rejects.toBe(lateLiveApplyError);
		expect(session.model).toBe(priorLiveModel);
		expect(session.model?.api).toBe("anthropic-messages");
		expect(session.model?.baseUrl).toBe("https://example.invalid");
	});

	it("does not commit the durable default when session snapshot preflight flush fails", async () => {
		// Given
		const priorModelRoles = { default: "initial-provider/initial:low", planner: "planner/model:medium" };
		const entriesBeforeSelection = sessionManager.getEntries();
		const contextBeforeSelection = sessionManager.buildSessionContext();
		const flushError = new Error("session snapshot flush failed");
		settings.set("modelRoles", priorModelRoles);
		vi.spyOn(sessionManager, "flush").mockRejectedValue(flushError);

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toBe(flushError);
		expect(settings.getGlobal("modelRoles")).toEqual(priorModelRoles);
		expect(session.model).toBe(INITIAL_MODEL);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(sessionManager.getEntries()).toEqual(entriesBeforeSelection);
		expect(sessionManager.buildSessionContext()).toEqual(contextBeforeSelection);
	});

	it("closes an already-open persisted append writer when late live apply rollback rewrites the transcript", async () => {
		// Given
		const storage = new AppendWriterTrackingStorage();
		const persistentManager = SessionManager.create(tempRoot, path.join(tempRoot, "sessions"), storage);
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const lateLiveApplyError = new Error("late live apply failure");
		await persistentManager.ensureOnDisk();
		persistentManager.appendMessage({ role: "user", content: "open hot writer", timestamp: Date.now() });
		await persistentManager.flush();
		expect(storage.openAppendWriterCount).toBe(1);
		const originalLiveApply = persistentSession.setModelTemporary.bind(persistentSession);
		vi.spyOn(persistentSession, "setModelTemporary").mockImplementationOnce(async (...args) => {
			await originalLiveApply(...args);
			throw lateLiveApplyError;
		});

		try {
			// When
			const selection = persistentSession.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			await expect(selection).rejects.toBe(lateLiveApplyError);
			expect(storage.openAppendWriterCount).toBe(0);
		} finally {
			await persistentSession.dispose();
			await persistentManager.close();
		}
	});

	it("restores the exact persisted transcript and context when target live apply fails late", async () => {
		// Given
		const persistentManager = SessionManager.create(tempRoot, tempRoot);
		const persistentSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: persistentManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const lateLiveApplyError = new Error("late live apply failure");
		persistentManager.appendMessage({ role: "user", content: "persisted transcript", timestamp: Date.now() });
		await persistentManager.rewriteEntries();
		const sessionFile = persistentSession.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		const entriesBeforeSelection = persistentManager.getEntries();
		const contextBeforeSelection = persistentManager.buildSessionContext();
		const originalLiveApply = persistentSession.setModelTemporary.bind(persistentSession);
		vi.spyOn(persistentSession, "setModelTemporary").mockImplementationOnce(async (...args) => {
			await originalLiveApply(...args);
			throw lateLiveApplyError;
		});

		try {
			// When
			const selection = persistentSession.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			await expect(selection).rejects.toBe(lateLiveApplyError);
			expect(persistentManager.getEntries()).toEqual(entriesBeforeSelection);
			expect(persistentManager.buildSessionContext()).toEqual(contextBeforeSelection);
			await persistentManager.flush();
			await persistentManager.close();
			const reopenedManager = await SessionManager.open(sessionFile, tempRoot);
			try {
				expect(reopenedManager.getEntries()).toEqual(entriesBeforeSelection);
				expect(reopenedManager.buildSessionContext()).toEqual(contextBeforeSelection);
			} finally {
				await reopenedManager.close();
			}
		} finally {
			await persistentSession.dispose();
			await persistentManager.close();
		}
	});

	it("restores a model-less session's live model, thinking, entries, and context when target live apply fails late", async () => {
		// Given
		const modelLessManager = SessionManager.inMemory(tempRoot);
		const modelLessSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: undefined, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: modelLessManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const priorModelRoles = { planner: "planner/model:medium" };
		const priorThinkingLevel = modelLessSession.thinkingLevel;
		const lateLiveApplyError = new Error("late live apply failure");
		settings.set("modelRoles", priorModelRoles);
		modelLessManager.appendMessage({ role: "user", content: "model-less transcript", timestamp: Date.now() });
		const entriesBeforeSelection = modelLessManager.getEntries();
		const contextBeforeSelection = modelLessManager.buildSessionContext();
		const originalLiveApply = modelLessSession.setModelTemporary.bind(modelLessSession);
		vi.spyOn(modelLessSession, "setModelTemporary").mockImplementationOnce(async (...args) => {
			await originalLiveApply(...args);
			throw lateLiveApplyError;
		});

		try {
			// When
			const selection = modelLessSession.setDefaultModelSelection(targetModel(), Effort.High);

			// Then
			await expect(selection).rejects.toBe(lateLiveApplyError);
			expect(settings.getGlobal("modelRoles")).toEqual(priorModelRoles);
			expect(modelLessSession.model).toBeUndefined();
			expect(modelLessSession.thinkingLevel).toBe(priorThinkingLevel);
			expect(modelLessManager.getEntries()).toEqual(entriesBeforeSelection);
			expect(modelLessManager.buildSessionContext()).toEqual(contextBeforeSelection);
		} finally {
			await modelLessSession.dispose();
		}
	});

	it("preserves the target live apply error when restoring the prior live selection fails", async () => {
		// Given
		const priorLiveModel = session.model;
		const model = targetModel();
		const lateLiveApplyError = new Error("late live apply failure");
		const liveRollbackError = new Error("live rollback failure");
		const originalLiveApply = session.setModelTemporary.bind(session);
		const liveApply = vi.spyOn(session, "setModelTemporary").mockImplementationOnce(async (...args) => {
			await originalLiveApply(...args);
			throw lateLiveApplyError;
		});
		const originalSetModel = session.agent.setModel.bind(session.agent);
		const restoreModel = vi.spyOn(session.agent, "setModel").mockImplementation(appliedModel => {
			if (appliedModel === priorLiveModel) throw liveRollbackError;
			originalSetModel(appliedModel);
		});
		const rollbackWarning = vi.spyOn(logger, "warn");

		// When
		const selection = session.setDefaultModelSelection(model, Effort.High);

		// Then
		await expect(selection).rejects.toBe(lateLiveApplyError);
		expect(liveApply).toHaveBeenCalledWith(model, Effort.High);
		expect(restoreModel).toHaveBeenCalledWith(priorLiveModel);
		expect(rollbackWarning).toHaveBeenCalledWith(
			"Failed to restore live default model selection after live apply failure",
			{ error: "Error: live rollback failure" },
		);
	});

	it.each([
		[
			"the prior session default",
			"initial-provider/initial",
			{ default: "initial-provider/initial:low", planner: "planner/model:medium" },
		],
		["no prior session default", undefined, { planner: "planner/model:medium" }],
	])("restores %s when live apply fails after a partial session mutation", async (_description, previousSessionDefault, previousModelRoles) => {
		// Given
		if (previousSessionDefault) {
			sessionManager.appendModelChange(previousSessionDefault, "default");
		}
		settings.set("modelRoles", previousModelRoles);
		const entriesBeforeSelection = sessionManager.getEntries();
		const defaultEntriesBeforeSelection = entriesBeforeSelection.filter(
			entry => entry.type === "model_change" && entry.role === "default",
		);
		const liveApplyError = new Error("late live apply failure");
		const originalLiveApply = session.setModelTemporary.bind(session);
		vi.spyOn(session, "setModelTemporary").mockImplementation(async (...args) => {
			await originalLiveApply(...args);
			throw liveApplyError;
		});

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toBe(liveApplyError);
		expect(settings.getGlobal("modelRoles")).toEqual(previousModelRoles);
		expect(
			sessionManager.getEntries().filter(entry => entry.type === "model_change" && entry.role === "default"),
		).toEqual(defaultEntriesBeforeSelection);
		expect(sessionManager.buildSessionContext().models.default === previousSessionDefault).toBeTrue();
	});

	it.each([
		["the previous default", { default: "original-provider/original:low", planner: "planner/model:medium" }],
		["no previous default", { planner: "planner/model:medium" }],
	])("restores %s when post-commit live apply fails", async (_description, previousModelRoles) => {
		// Given
		settings.set("modelRoles", previousModelRoles);
		vi.spyOn(session, "setModelTemporary").mockRejectedValue(new Error("live apply failed"));

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toThrow("live apply failed");
		expect(settings.getGlobal("modelRoles")).toEqual(previousModelRoles);
		expect(session.model).toBe(INITIAL_MODEL);
	});

	it("preserves the live apply error when restoring the durable default also fails", async () => {
		// Given
		const liveApplyError = new Error("live apply failed");
		const rollbackError = new Error("durable rollback failed");
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (role, modelId) => {
			if (modelId === undefined) throw rollbackError;
			await originalDurableCommit(role, modelId);
		});
		vi.spyOn(session, "setModelTemporary").mockRejectedValue(liveApplyError);
		const rollbackWarning = vi.spyOn(logger, "warn");

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toBe(liveApplyError);
		expect(rollbackWarning).toHaveBeenCalledWith(
			"Failed to restore durable default model selection after live apply failure",
			{ error: "Error: durable rollback failed" },
		);
	});
});
