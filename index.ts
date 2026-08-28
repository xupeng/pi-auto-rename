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

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
		ctx.ui.notify(message, level);
	}

	function errMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function persistState(source: RenameSource, name: string): void {
		writeState(pi, { name, source, timestamp: Date.now() });
	}

	function persistConfig(ctx: ExtensionContext, summary: string): void {
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
		state.manual = true;
		state.lastSetName = name;
		state.lastAutoName = name;
		pi.setSessionName(name);
		persistState("manual", name);
		notify(ctx, `Session named: ${name}`, "info");
	}

	// ---------- automatic naming attempts ----------

	async function attemptFirstNaming(ctx: ExtensionContext): Promise<void> {
		if (!config.autoRename || state.manual || state.inFlight) return;
		if (Date.now() - state.lastFailTime < FIRST_NAMING_RETRY_MS) return;
		if (pi.getSessionName()) return;
		if (state.lastAutoName) return;

		const input = firstMessages(ctx.sessionManager.getBranch());
		if (!input) return;

		state.inFlight = true;
		try {
			const result = await generateName(ctx, config, "first", input);
			if (result.error) {
				state.lastFailTime = Date.now();
				notify(ctx, `Auto rename skipped: ${result.error}`, "warning");
				return;
			}
			if (result.name && !pi.getSessionName()) {
				applyAutoName(ctx, result.name);
			}
		} finally {
			state.inFlight = false;
		}
	}

	async function evaluateContinuous(ctx: ExtensionContext): Promise<void> {
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

		state.inFlight = true;
		try {
			const result = await generateName(ctx, config, "update", input, { currentName });
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
			applyAutoName(ctx, name, "renamed");
		} finally {
			state.inFlight = false;
		}
	}

	// ---------- events ----------

	pi.on("session_start", async (_event, ctx) => {
		try {
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
			await attemptFirstNaming(ctx);
		} catch (error) {
			notify(ctx, `Auto rename init failed: ${errMessage(error)}`, "warning");
		}
	});

	pi.on("session_info_changed", async (event) => {
		try {
			// Our own setSessionName() call — keep the recorded state.
			if (event.name === state.lastSetName) return;

			// External rename (e.g. /name or another extension): mark manual.
			state.manual = true;
			state.lastSetName = event.name ?? null;
			if (event.name) state.lastAutoName = event.name;
			persistState("manual", event.name ?? state.lastAutoName ?? "");
		} catch (error) {
			console.error(`[pi-auto-rename] session_info_changed handler failed: ${errMessage(error)}`);
		}
	});

	pi.on("message_end", async (_event, ctx) => {
		try {
			await attemptFirstNaming(ctx);
		} catch (error) {
			notify(ctx, `Auto rename failed: ${errMessage(error)}`, "warning");
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			await evaluateContinuous(ctx);
		} catch (error) {
			notify(ctx, `Continuous rename failed: ${errMessage(error)}`, "warning");
		}
	});

	// ---------- /rename command ----------

	pi.registerCommand("rename", {
		description:
			"Name the session: /rename <name> sets it directly; /rename (no args) generates a title from the full history",
		handler: async (args, ctx) => {
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

				const result = await generateName(ctx, config, "history", history);
				if (result.error) {
					notify(ctx, `Failed to name session: ${result.error}`, "error");
					return;
				}
				if (result.name) applyManualName(ctx, result.name);
			} catch (error) {
				notify(ctx, `Failed to rename session: ${errMessage(error)}`, "error");
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
