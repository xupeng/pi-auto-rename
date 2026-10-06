/**
 * pi-auto-rename — modern session auto-rename extension.
 *
 * Behavior:
 * - After the first user message (and on session start with messages but no
 *   name), names the session once with a short AI title derived from the
 *   first 3 non-empty messages. Zero-config: the naming model follows the
 *   session's current model unless overridden via /rename-config.
 * - Optional continuous re-naming (off by default): on agent_settled, only
 *   when ≥5 minutes passed since the last auto name AND ≥3 new messages were
 *   added, the model decides whether the topic shifted (KEEP vs new title).
 *   An in-flight flag prevents overlapping calls.
 * - Manual names are never overwritten: /name, /rename <name>, and /rename
 *   (AI) all mark the session as manual; the flag is persisted via
 *   pi.appendEntry("pi-auto-rename:state") so it survives restart/resume.
 *   External renames are detected in session_info_changed by comparing the
 *   event name with the name this extension last set.
 *
 * Automatic naming never blocks the agent. Lifecycle handlers reserve a
 * session-owned request synchronously and return; the provider call is deferred
 * and raced against an independent 30s deadline. Every success, error,
 * notification, cooldown update, and finalizer re-checks request ownership, so a
 * late result cannot mutate a replaced session/branch or release a newer
 * request. Session shutdown, branch navigation, manual renames, and disabling
 * automatic naming all invalidate the affected pending request.
 *
 * Commands:
 * - /rename [name]            set directly (manual) or generate from history
 * - /rename-config <sub>      model | style | auto | continuous | language
 *
 * All handlers are wrapped in try/catch — the extension never throws.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	defaultConfig,
	CONFIG_FILE_PATH,
	loadConfig,
	resetConfigFile,
	saveConfig,
	type RenameConfig,
	type RenameLanguage,
	type RenameStyle,
} from "./config.ts";
import { readState, writeState, type RenameSource } from "./state.ts";
import { generateName } from "./naming.ts";
import { runInteractiveConfig } from "./ui-config.ts";

const CONTINUOUS_MIN_INTERVAL_MS = 5 * 60 * 1000;
const CONTINUOUS_MIN_NEW_MESSAGES = 3;
const FIRST_NAMING_RETRY_MS = 5 * 60 * 1000;
const FIRST_MESSAGE_LIMIT = 3;
const MESSAGE_LIMIT_CHARS = 4000;
const HISTORY_LIMIT_CHARS = 8000;
const RECENT_MESSAGES_LIMIT = 6;

const CONFIG_SUBCOMMANDS = ["model", "style", "auto", "continuous", "language"] as const;
const STYLE_VALUES = ["concise", "formal", "playful", "custom"] as const;
const LANGUAGE_VALUES = ["auto", "zh", "en"] as const;

/** Per-session in-memory state, rebuilt on every session_start. */
interface PerSessionState {
	manual: boolean;
	/** Name this extension last set (any source); null before the first set. */
	lastSetName: string | null;
	/** Name of the last automatic naming; used for external-change detection. */
	lastAutoName: string | null;
	/** Timestamp of the last automatic naming; 0 = never. */
	lastAutoTime: number;
	/** Non-empty user/assistant message count at the last automatic naming. */
	lastAutoCount: number;
	/** True while a naming request is in flight (single-flight guard). */
	inFlight: boolean;
	/** Timestamp of the last failed automatic naming; 0 = never failed. */
	lastFailTime: number;
}

type AutomaticNamingKind = "first" | "continuous";
type RequestKind = AutomaticNamingKind | "manual";

/**
 * A naming request that owns the single-flight guard. An automatic request is
 * created synchronously by a lifecycle handler and deferred; an explicit
 * /rename (AI) request is created by the command and awaited. Either way a
 * lifecycle/session transition, a manual rename, or a newer request can
 * invalidate it before or while it runs.
 */
interface PendingRequest {
	kind: RequestKind;
	/** Session/branch generation captured when the request was reserved. */
	generation: number;
	/** Name/manual revision captured when the request was reserved. */
	nameEpoch: number;
	/** Request-owned cancellation source (never the primary agent's controller). */
	controller: AbortController;
	/** Set once a newer owner or a lifecycle transition supersedes this request. */
	invalidated: boolean;
	/** For continuous requests: the title the update was compared against. */
	baseName?: string;
}

type CompletionItem = { value: string; label: string };

interface MessageText {
	role: "user" | "assistant";
	text: string;
}

export default function autoRename(pi: ExtensionAPI): void {
	let config: RenameConfig = loadConfig();

	const state: PerSessionState = {
		manual: false,
		lastSetName: null,
		lastAutoName: null,
		lastAutoTime: 0,
		lastAutoCount: 0,
		inFlight: false,
		lastFailTime: 0,
	};

	/** provider/id refs for /rename-config model completions (refreshed per session). */
	let modelRefs: string[] = [];

	/** Request (automatic or explicit) currently holding the single-flight guard. */
	let activeRequest: PendingRequest | null = null;
	/** Bumped on every session replacement and successful branch navigation. */
	let branchGeneration = 0;
	/** Bumped on every name/manual revision change (rename, clear, external rename). */
	let nameEpoch = 0;

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
		try {
			ctx.ui.notify(message, level);
		} catch {
			// A context can be invalidated between an async boundary and a
			// background notification; a stale notification must not reject.
		}
	}

	function errMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function readSessionId(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.sessionManager.getSessionId();
		} catch {
			// The session manager is invalidated after a session replacement.
			return undefined;
		}
	}

	// ---------- background request ownership ----------

	/**
	 * Release an automatic or manual request. Mark the owner stale and abort its
	 * owned controller; provider cooperation is not required for local release.
	 * A late resolution/rejection can then no longer mutate
	 * the session, notify, update the failure cooldown, or release a newer
	 * request's single-flight guard.
	 */
	function releaseRequest(request: PendingRequest): void {
		request.invalidated = true;
		if (activeRequest === request) {
			activeRequest = null;
			state.inFlight = false;
		}
		try {
			request.controller.abort();
		} catch {
			// AbortController.abort() does not throw; keep shutdown paths total.
		}
	}

	function invalidateActiveRequest(kind?: RequestKind): void {
		const request = activeRequest;
		if (!request) return;
		if (kind && request.kind !== kind) return;
		releaseRequest(request);
	}

	/**
	 * Invalidate a pending automatic request without touching an explicit
	 * /rename (AI) request, which must survive config changes.
	 */
	function invalidateAutomaticRequest(kind?: AutomaticNamingKind): void {
		const request = activeRequest;
		if (!request || request.kind === "manual") return;
		if (kind && request.kind !== kind) return;
		releaseRequest(request);
	}

	/** True while this request still owns the session/branch/name it was launched on. */
	function isCurrentRequest(request: PendingRequest): boolean {
		return (
			!request.invalidated &&
			activeRequest === request &&
			request.generation === branchGeneration &&
			request.nameEpoch === nameEpoch
		);
	}

	/** True while this request still owns the single-flight guard (release check). */
	function ownsGuard(request: PendingRequest): boolean {
		return activeRequest === request;
	}

	/** Reserve the single-flight guard synchronously, before deferring the call. */
	function reserveAutomaticRequest(kind: AutomaticNamingKind, baseName?: string): PendingRequest | null {
		if (!config.autoRename || state.manual || state.inFlight) return null;
		const request: PendingRequest = {
			kind,
			generation: branchGeneration,
			nameEpoch,
			controller: new AbortController(),
			invalidated: false,
			baseName,
		};
		activeRequest = request;
		state.inFlight = true;
		return request;
	}

	/**
	 * Reserve an explicit /rename (AI) request. It supersedes any pending
	 * automatic or earlier manual request and suspends automatic scheduling
	 * (state.inFlight) until the command settles.
	 */
	function reserveManualRequest(): PendingRequest {
		invalidateActiveRequest();
		const request: PendingRequest = {
			kind: "manual",
			generation: branchGeneration,
			nameEpoch,
			controller: new AbortController(),
			invalidated: false,
		};
		activeRequest = request;
		state.inFlight = true;
		return request;
	}

	/**
	 * Re-check the automatic mode after any config change and invalidate work it
	 * no longer covers: auto-off cancels automatic work, continuous-off cancels
	 * only a continuous request. An explicit /rename (AI) is not affected.
	 */
	function enforceModeInvalidation(): void {
		if (!config.autoRename) {
			invalidateAutomaticRequest();
			return;
		}
		if (!config.continuousRename) invalidateAutomaticRequest("continuous");
	}

	function persistState(source: RenameSource, name: string): void {
		writeState(pi, { name, source, timestamp: Date.now() });
	}

	function persistConfig(ctx: ExtensionContext, summary: string): void {
		enforceModeInvalidation();
		if (saveConfig(config)) {
			notify(ctx, summary, "info");
		} else {
			notify(ctx, `${summary} (applied for this runtime, failed to persist to disk)`, "warning");
		}
	}

	function collectModelRefs(ctx: ExtensionContext): string[] {
		const models = ctx.scopedModels.length
			? ctx.scopedModels.map((entry) => entry.model)
			: ctx.modelRegistry.getAvailable();
		return [...new Set(models.map((model) => `${model.provider}/${model.id}`))].sort();
	}

	function parseModelRef(value: string): { provider: string; id: string } | null {
		const input = value.trim();
		const slashIndex = input.indexOf("/");
		if (slashIndex <= 0 || slashIndex === input.length - 1) return null;
		const provider = input.slice(0, slashIndex).trim();
		const id = input.slice(slashIndex + 1).trim();
		if (!provider || !id) return null;
		return { provider, id };
	}

	// ---------- session text helpers ----------

	function extractTextFromContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter(
				(item): item is { type: string; text?: string } =>
					typeof item === "object" && item !== null,
			)
			.filter((item) => item.type === "text" && typeof item.text === "string")
			.map((item) => item.text as string)
			.join("\n");
	}

	function nonEmptyMessages(entries: readonly SessionEntry[]): MessageText[] {
		const out: MessageText[] = [];
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (!message) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = extractTextFromContent(message.content).trim();
			if (!text) continue;
			out.push({ role: message.role, text });
		}
		return out;
	}

	function truncate(text: string, max: number): string {
		return text.length > max ? text.slice(0, max) : text;
	}

	function formatMessages(messages: MessageText[], maxPerMessage: number): string {
		return messages
			.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${truncate(message.text, maxPerMessage)}`)
			.join("\n\n");
	}

	/** First 3 non-empty user/assistant messages, each ≤4000 chars. */
	function firstMessages(entries: readonly SessionEntry[]): string | null {
		const messages = nonEmptyMessages(entries).slice(0, FIRST_MESSAGE_LIMIT);
		if (messages.length === 0) return null;
		return formatMessages(messages, MESSAGE_LIMIT_CHARS);
	}

	/** Last 6 non-empty user/assistant messages, each ≤4000 chars. */
	function recentMessages(entries: readonly SessionEntry[]): string | null {
		const messages = nonEmptyMessages(entries).slice(-RECENT_MESSAGES_LIMIT);
		if (messages.length === 0) return null;
		return formatMessages(messages, MESSAGE_LIMIT_CHARS);
	}

	/** Full conversation transcript, total ≤8000 chars. */
	function fullHistory(entries: readonly SessionEntry[]): string | null {
		const messages = nonEmptyMessages(entries);
		if (messages.length === 0) return null;
		const text = messages
			.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
			.join("\n\n");
		return truncate(text, HISTORY_LIMIT_CHARS);
	}

	// ---------- applying names ----------

	function applyAutoName(ctx: ExtensionContext, name: string, verb = "named"): void {
		// Iron rule: once the session is manual, no automatic path may name it.
		if (state.manual) return;
		state.lastSetName = name;
		state.lastAutoName = name;
		state.lastAutoTime = Date.now();
		state.lastAutoCount = nonEmptyMessages(ctx.sessionManager.getBranch()).length;
		pi.setSessionName(name);
		persistState("auto", name);
		notify(ctx, `Session ${verb}: ${name}`, "info");
	}

	function applyManualName(ctx: ExtensionContext, name: string): void {
		// A manual name supersedes any pending automatic title.
		invalidateActiveRequest();
		nameEpoch++;
		state.manual = true;
		state.lastSetName = name;
		state.lastAutoName = name;
		pi.setSessionName(name);
		persistState("manual", name);
		notify(ctx, `Session named: ${name}`, "info");
	}

	// ---------- automatic naming attempts ----------

	/**
	 * Schedule a first-naming request without blocking the caller. Eligibility is
	 * checked and the single-flight guard reserved synchronously; the provider
	 * call is deferred to a microtask so the lifecycle handler returns first.
	 */
	function scheduleFirstNaming(ctx: ExtensionContext): void {
		if (!config.autoRename || state.manual || state.inFlight) return;
		if (Date.now() - state.lastFailTime < FIRST_NAMING_RETRY_MS) return;
		if (pi.getSessionName()) return;
		if (state.lastAutoName) return;

		const input = firstMessages(ctx.sessionManager.getBranch());
		if (!input) return;

		// Capture configuration and input before a context replacement can occur.
		const configSnapshot: RenameConfig = { ...config };
		const request = reserveAutomaticRequest("first");
		if (!request) return;
		queueMicrotask(() => {
			void runFirstNaming(ctx, request, input, configSnapshot);
		});
	}

	async function runFirstNaming(
		ctx: ExtensionContext,
		request: PendingRequest,
		input: string,
		configSnapshot: RenameConfig,
	): Promise<void> {
		try {
			if (!isCurrentRequest(request)) return;
			if (!config.autoRename) return;

			const result = await generateName(ctx, configSnapshot, "first", input, {
				signal: request.controller.signal,
			});
			if (!isCurrentRequest(request)) return;
			if (result.reason === "cancelled") return;
			if (result.error) {
				state.lastFailTime = Date.now();
				notify(ctx, `Auto rename skipped: ${result.error}`, "warning");
				return;
			}
			if (result.name && !state.manual && !pi.getSessionName()) {
				applyAutoName(ctx, result.name);
			}
		} catch (error) {
			if (isCurrentRequest(request)) {
				notify(ctx, `Auto rename failed: ${errMessage(error)}`, "warning");
			}
		} finally {
			// Only the owner may release the guard: an old request's finally must
			// not clear a newer request's bookkeeping.
			if (ownsGuard(request)) {
				activeRequest = null;
				state.inFlight = false;
			}
		}
	}

	/** Schedule a continuous re-evaluation without blocking the settle handler. */
	function scheduleContinuous(ctx: ExtensionContext): void {
		if (!config.autoRename || !config.continuousRename) return;
		if (state.manual || state.inFlight) return;
		if (state.lastAutoTime === 0) return;

		const now = Date.now();
		if (now - state.lastAutoTime < CONTINUOUS_MIN_INTERVAL_MS) return;

		const count = nonEmptyMessages(ctx.sessionManager.getBranch()).length;
		if (count - state.lastAutoCount < CONTINUOUS_MIN_NEW_MESSAGES) return;

		const currentName = pi.getSessionName();
		if (!currentName) return;

		const input = recentMessages(ctx.sessionManager.getBranch());
		if (!input) return;

		const configSnapshot: RenameConfig = { ...config };
		const request = reserveAutomaticRequest("continuous", currentName);
		if (!request) return;
		queueMicrotask(() => {
			void runContinuous(ctx, request, input, configSnapshot);
		});
	}

	async function runContinuous(
		ctx: ExtensionContext,
		request: PendingRequest,
		input: string,
		configSnapshot: RenameConfig,
	): Promise<void> {
		const currentName = request.baseName;
		try {
			if (!isCurrentRequest(request)) return;
			if (!config.autoRename || !config.continuousRename || state.manual) return;
			if (currentName === undefined) return;

			const result = await generateName(ctx, configSnapshot, "update", input, {
				signal: request.controller.signal,
				currentName,
			});
			if (!isCurrentRequest(request)) return;
			if (result.reason === "cancelled") return;
			if (result.error) {
				notify(ctx, `Continuous rename skipped: ${result.error}`, "warning");
				return;
			}
			const name = result.name;
			if (!name || name.toUpperCase() === "KEEP" || name === currentName) return;
			// Re-check after the await: the user may have renamed the session
			// (marking it manual) while the naming request was in flight.
			if (state.manual) return;
			if (pi.getSessionName() !== currentName) return;
			if (!config.autoRename || !config.continuousRename) return;
			applyAutoName(ctx, name, "renamed");
		} catch (error) {
			if (isCurrentRequest(request)) {
				notify(ctx, `Continuous rename failed: ${errMessage(error)}`, "warning");
			}
		} finally {
			// Only the owner may release the guard: an old request's finally must
			// not clear a newer request's bookkeeping.
			if (ownsGuard(request)) {
				activeRequest = null;
				state.inFlight = false;
			}
		}
	}

	// ---------- events ----------

	pi.on("session_start", async (_event, ctx) => {
		try {
			// A new session lifecycle supersedes work bound to the old session or
			// branch before state is rebuilt.
			invalidateActiveRequest();
			branchGeneration++;
			nameEpoch++;
			const branch = ctx.sessionManager.getBranch();
			const saved = readState(branch);

			state.manual = false;
			state.lastSetName = null;
			state.lastAutoName = null;
			state.lastAutoTime = 0;
			state.lastAutoCount = nonEmptyMessages(branch).length;
			state.inFlight = false;
			state.lastFailTime = 0;

			if (saved) {
				state.lastAutoName = saved.name;
				state.lastSetName = saved.name;
				if (saved.source === "manual") {
					state.manual = true;
				} else {
					state.lastAutoTime = saved.timestamp;
				}
			}

			// A session name that differs from the one this extension recorded
			// means the user renamed it externally — protect it forever.
			const currentName = pi.getSessionName();
			if (!state.manual && currentName && currentName !== state.lastAutoName) {
				state.manual = true;
				persistState("manual", currentName);
			}

			modelRefs = collectModelRefs(ctx);

			// Name sessions that already have messages but no name (e.g. an
			// older session resumed for the first time). New sessions are
			// empty here, so this is a no-op for them.
			scheduleFirstNaming(ctx);
		} catch (error) {
			notify(ctx, `Auto rename init failed: ${errMessage(error)}`, "warning");
		}
	});

	pi.on("session_info_changed", async (event) => {
		try {
			// Our own setSessionName() call — keep the recorded state.
			if (event.name === state.lastSetName) return;

			// External rename (e.g. /name or another extension): supersede any
			// pending automatic title, then mark manual.
			invalidateActiveRequest();
			nameEpoch++;
			state.manual = true;
			state.lastSetName = event.name ?? null;
			if (event.name) state.lastAutoName = event.name;
			persistState("manual", event.name ?? state.lastAutoName ?? "");
		} catch (error) {
			console.error(`[pi-auto-rename] session_info_changed handler failed: ${errMessage(error)}`);
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			// Quit, reload, or session replacement: cancel scheduled/running work
			// without awaiting the provider.
			invalidateActiveRequest();
			branchGeneration++;
		} catch (error) {
			console.error(`[pi-auto-rename] session_shutdown handler failed: ${errMessage(error)}`);
		}
	});

	pi.on("session_before_tree", async () => {
		try {
			// Conservative: cancel branch-bound work before navigation, even if
			// another extension cancels the navigation (later triggers can retry).
			invalidateActiveRequest();
		} catch (error) {
			console.error(`[pi-auto-rename] session_before_tree handler failed: ${errMessage(error)}`);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		try {
			// Successful navigation advanced the branch: invalidate stale work and
			// refresh branch-dependent counts.
			invalidateActiveRequest();
			branchGeneration++;
			state.lastAutoCount = nonEmptyMessages(ctx.sessionManager.getBranch()).length;
		} catch (error) {
			console.error(`[pi-auto-rename] session_tree handler failed: ${errMessage(error)}`);
		}
	});

	pi.on("message_end", async (_event, ctx) => {
		try {
			scheduleFirstNaming(ctx);
		} catch (error) {
			notify(ctx, `Auto rename failed: ${errMessage(error)}`, "warning");
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			scheduleContinuous(ctx);
		} catch (error) {
			notify(ctx, `Continuous rename failed: ${errMessage(error)}`, "warning");
		}
	});

	// ---------- /rename command ----------

	pi.registerCommand("rename", {
		description:
			"Name the session: /rename <name> sets it directly; /rename (no args) generates a title from the full history",
		handler: async (args, ctx) => {
			let request: PendingRequest | null = null;
			try {
				const trimmed = args.trim();
				if (trimmed) {
					applyManualName(ctx, trimmed);
					return;
				}

				const history = fullHistory(ctx.sessionManager.getBranch());
				if (!history) {
					notify(ctx, "No conversation history available to name this session.", "warning");
					return;
				}

				// Supersede pending automatic/earlier manual work and suspend
				// automatic scheduling until this explicit request settles.
				request = reserveManualRequest();
				const sessionId = readSessionId(ctx);

				const result = await generateName(ctx, config, "history", history, {
					signal: request.controller.signal,
				});
				// Apply only while the captured session/branch/name revision still
				// belongs to this command: an explicit clear (undefined === undefined)
				// or an ABA rename must not be overwritten by a stale result.
				if (!isCurrentRequest(request)) return;
				if (readSessionId(ctx) !== sessionId) return;
				if (result.reason === "cancelled") return;
				if (result.error) {
					notify(ctx, `Failed to name session: ${result.error}`, "error");
					return;
				}
				if (result.name) applyManualName(ctx, result.name);
			} catch (error) {
				notify(ctx, `Failed to rename session: ${errMessage(error)}`, "error");
			} finally {
				// Failure restores automatic eligibility; success already released the
				// guard via applyManualName. Only the owner releases it.
				if (request && ownsGuard(request)) {
					activeRequest = null;
					state.inFlight = false;
				}
			}
		},
	});

	// ---------- /rename-config command ----------

	function showConfig(ctx: ExtensionCommandContext): void {
		const model = config.model ? `${config.model.provider}/${config.model.id}` : "follow session model";
		const custom = config.style === "custom" ? ` (${config.customStyle ?? ""})` : "";
		notify(
			ctx,
			`Rename config — model: ${model}; style: ${config.style}${custom}; auto: ${config.autoRename ? "on" : "off"}; ` +
				`continuous: ${config.continuousRename ? "on" : "off"}; language: ${config.language}`,
			"info",
		);
		notify(ctx, `Config file: ${CONFIG_FILE_PATH}`, "info");
	}

	async function handleModelConfig(value: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!value) {
			if (!ctx.hasUI) {
				notify(ctx, "No interactive UI available. Use /rename-config model provider/id (or none)", "warning");
				return;
			}
			const refs = collectModelRefs(ctx);
			if (refs.length === 0) {
				notify(ctx, "No models with configured auth are available.", "warning");
				return;
			}
			const selected = await ctx.ui.select("Select rename model:", refs);
			if (!selected) return;
			config.model = parseModelRef(selected) ?? undefined;
			persistConfig(ctx, `Rename model set to ${selected}`);
			return;
		}

		if (value === "none") {
			config.model = undefined;
			persistConfig(ctx, "Rename model cleared (follows session model)");
			return;
		}

		const ref = parseModelRef(value);
		if (!ref) {
			notify(ctx, "Invalid model. Usage: /rename-config model provider/id (or none)", "warning");
			return;
		}
		if (!ctx.modelRegistry.find(ref.provider, ref.id)) {
			notify(ctx, `Model not found: ${ref.provider}/${ref.id}`, "warning");
			return;
		}
		config.model = ref;
		persistConfig(ctx, `Rename model set to ${ref.provider}/${ref.id}`);
	}

	function handleStyleConfig(parts: string[], ctx: ExtensionCommandContext): void {
		const value = parts[1];

		if (value === "custom") {
			const description = parts.slice(2).join(" ").trim();
			if (!description) {
				notify(ctx, "Custom style needs a description: /rename-config style custom <description>", "warning");
				return;
			}
			config.style = "custom";
			config.customStyle = description;
			persistConfig(ctx, `Rename style set to custom (${description})`);
			return;
		}

		if ((STYLE_VALUES as readonly string[]).includes(value ?? "")) {
			config.style = value as RenameStyle;
			config.customStyle = undefined;
			persistConfig(ctx, `Rename style set to ${value}`);
			return;
		}

		notify(ctx, "Invalid style. Usage: /rename-config style concise|formal|playful|custom [description]", "warning");
	}

	function handleBoolConfig(
		sub: string,
		value: string,
		key: "autoRename" | "continuousRename",
		label: string,
		ctx: ExtensionCommandContext,
	): void {
		if (value === "on" || value === "off") {
			config[key] = value === "on";
			persistConfig(ctx, `${label}: ${value}`);
			return;
		}
		notify(ctx, `Invalid value. Usage: /rename-config ${sub} on|off`, "warning");
	}

	function handleLanguageConfig(value: string, ctx: ExtensionCommandContext): void {
		if ((LANGUAGE_VALUES as readonly string[]).includes(value)) {
			config.language = value as RenameLanguage;
			persistConfig(ctx, `Rename title language set to ${value}`);
			return;
		}
		notify(ctx, "Invalid language. Usage: /rename-config language auto|zh|en", "warning");
	}

	async function handleRenameConfig(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args.trim();
		if (!trimmed) {
			if (ctx.hasUI) {
				await runInteractiveConfig(ctx, {
					getConfig: () => config,
					applyConfig: (patch, summary) => {
						Object.assign(config, patch);
						persistConfig(ctx, summary);
					},
					collectModelRefs: () => collectModelRefs(ctx),
					resetConfig: () => {
						config = defaultConfig();
						enforceModeInvalidation();
						return resetConfigFile();
					},
					notify: (message, level) => notify(ctx, message, level),
				});
			} else {
				showConfig(ctx);
				notify(
					ctx,
					"No interactive UI. Use /rename-config model|style|auto|continuous|language <value>",
					"warning",
				);
			}
			return;
		}

		const parts = trimmed.split(/\s+/);
		const sub = parts[0];
		const value = parts.slice(1).join(" ");

		switch (sub) {
			case "model":
				await handleModelConfig(value, ctx);
				return;
			case "style":
				handleStyleConfig(parts, ctx);
				return;
			case "auto":
				handleBoolConfig("auto", value, "autoRename", "Auto rename", ctx);
				return;
			case "continuous":
				handleBoolConfig("continuous", value, "continuousRename", "Continuous rename", ctx);
				return;
			case "language":
				handleLanguageConfig(value, ctx);
				return;
			default:
				notify(ctx, `Unknown option "${sub}". Usage: /rename-config model|style|auto|continuous|language`, "warning");
		}
	}

	function completeRenameConfigArgs(prefix: string): CompletionItem[] | null {
		const parts = prefix.trimStart().split(/\s+/);
		const sub = parts[0] ?? "";
		const rest = parts.slice(1).join(" ");

		// Completing the subcommand itself.
		if (parts.length === 1 && rest === "") {
			const matches = CONFIG_SUBCOMMANDS.filter((item) => item.startsWith(sub));
			return matches.length > 0 ? matches.map((item) => ({ value: item, label: item })) : null;
		}
		if (!(CONFIG_SUBCOMMANDS as readonly string[]).includes(sub)) return null;

		let candidates: readonly string[];
		switch (sub) {
			case "model":
				candidates = [...modelRefs, "none"];
				break;
			case "style":
				candidates = STYLE_VALUES;
				break;
			case "auto":
			case "continuous":
				candidates = ["on", "off"] as const;
				break;
			case "language":
				candidates = LANGUAGE_VALUES;
				break;
			default:
				return null;
		}
		const matches = candidates.filter((item) => item.startsWith(rest));
		return matches.length > 0 ? matches.map((item) => ({ value: item, label: item })) : null;
	}

	pi.registerCommand("rename-config", {
		description: "Configure auto rename: model | style | auto | continuous | language",
		getArgumentCompletions: (prefix) => completeRenameConfigArgs(prefix),
		handler: async (args, ctx) => {
			try {
				await handleRenameConfig(args, ctx);
			} catch (error) {
				notify(ctx, `Failed to update rename config: ${errMessage(error)}`, "error");
			}
		},
	});
}
