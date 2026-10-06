/**
 * pi-auto-rename — naming core.
 *
 * Resolves the naming model (config override, or the session's current model),
 * builds system/user prompts for the three naming kinds (first / history /
 * update), calls the AI through ctx.modelRegistry.complete(), and sanitizes the
 * raw output into a short title. All failures are returned as { error } — never
 * thrown.
 *
 * Why the registry and not @earendil-works/pi-ai/compat: compat's complete()
 * dispatches on pi-ai's global api registry, which only knows builtin api ids.
 * A provider registered by another extension (`registerProvider({ api,
 * streamSimple })`, e.g. cliproxyapi's "cliproxyapi-codex-responses") has no
 * entry there, so compat throws `No API provider registered for api: ...`.
 * ctx.modelRegistry.complete() resolves auth and routes through the provider pi
 * composed, so extension-provided api ids behave like builtin ones.
 */

import type { Api, Model, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RenameConfig } from "./config.ts";

export type NamingKind = "first" | "history" | "update";

export const MAX_TITLE_LENGTH = 80;
export const NAMING_MAX_TOKENS = 64;
export const NAMING_TIMEOUT_MS = 30 * 1000;

export interface NamingOptions {
	/** Current session title — required for kind === "update". */
	currentName?: string;
	/**
	 * Explicit cancellation source for the request. Replaces ctx.signal: automatic
	 * callers pass a session-owned signal instead of inheriting the signal of an
	 * unrelated primary agent run.
	 */
	signal?: AbortSignal;
}

export interface NamingResult {
	name?: string;
	error?: string;
	/**
	 * Why the request ended without a provider outcome: the independent deadline
	 * fired ("timeout") or the caller's signal aborted ("cancelled"). Automatic
	 * callers treat "cancelled" as supersession (silent, no failure cooldown) and
	 * "timeout" as a normal failure.
	 */
	reason?: "timeout" | "cancelled";
}

/** Resolve the model to use for naming. */
export function resolveModel(ctx: ExtensionContext, config: RenameConfig): { model?: Model<Api>; error?: string } {
	const override = config.model;
	if (override) {
		const model = ctx.modelRegistry.find(override.provider, override.id);
		if (!model) {
			return { error: `Rename model not found: ${override.provider}/${override.id}` };
		}
		return { model };
	}
	if (!ctx.model) {
		return { error: "No active session model available for naming" };
	}
	return { model: ctx.model };
}

function buildStyleLine(config: RenameConfig): string {
	switch (config.style) {
		case "formal":
			return "Formal, written tone: ≤ 12 Chinese characters or 2-6 English words";
		case "playful":
			return "Playful and lighthearted: ≤ 12 Chinese characters or 2-6 English words";
		case "custom":
			return config.customStyle?.trim() || "Concise: ≤ 12 Chinese characters or 2-6 English words";
		default:
			return "Concise: ≤ 12 Chinese characters or 2-6 English words";
	}
}

function buildLanguageLine(config: RenameConfig): string | null {
	switch (config.language) {
		case "zh":
			return "Always write the title in Chinese";
		case "en":
			return "Always write the title in English";
		default:
			return null;
	}
}

/** Build the system prompt for the naming model. */
export function buildSystemPrompt(config: RenameConfig): string {
	const languageLine = buildLanguageLine(config);
	const lines = [
		"You create short, descriptive titles for AI chat sessions.",
		"Rules:",
		`- ${buildStyleLine(config)}`,
		"- Match the primary language of the conversation (Chinese conversation → Chinese title; English → English)",
		...((languageLine ? [`- ${languageLine}`] : []) as string[]),
		"- No quotes, no trailing punctuation, no explanation",
		"- Respond with only the title",
	];
	return lines.join("\n");
}

/** Build the user message for a naming request. */
export function buildUserPrompt(kind: NamingKind, input: string, currentName?: string): UserMessage {
	let text: string;
	switch (kind) {
		case "first":
			text = `Based on the start of this conversation, create a title for this chat session.\n\nConversation start:\n${input}`;
			break;
		case "history":
			text = `Based on the full conversation history, create a title for this chat session.\n\nConversation history:\n${input}`;
			break;
		case "update":
			text = `Current title: ${currentName ?? "(none)"}\n\nRecent messages:\n${input}\n\nReply KEEP if the title still fits, otherwise reply with a new title only.`;
			break;
	}
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

/**
 * Clean raw model output into a title: first line, strip surrounding quotes,
 * collapse whitespace, drop trailing punctuation, hard cap at 80 chars.
 * Returns null when nothing usable remains.
 */
export function sanitizeName(raw: string): string | null {
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return null;

	let name = lines[0];
	name = name.replace(/^["'`“”‘’「」『』]+|["'`“”‘’「」『』]+$/g, "");
	name = name.replace(/\s+/g, " ").trim();
	name = name.replace(/[.!?:;，。！？；：]+$/, "");
	if (name.length > MAX_TITLE_LENGTH) {
		name = name.slice(0, MAX_TITLE_LENGTH).trimEnd();
	}
	return name.length > 0 ? name : null;
}

/**
 * Generate a title for the given input using the resolved naming model.
 * Returns { name } on success or { error } on any failure — never throws.
 */
export async function generateName(
	ctx: ExtensionContext,
	config: RenameConfig,
	kind: NamingKind,
	input: string,
	options?: NamingOptions,
): Promise<NamingResult> {
	// Every request owns a request-specific controller and an independent 30s
	// deadline, whether or not an upstream signal exists: a provider that ignores
	// abort must not be able to keep the extension's request pending forever.
	// The controller is only used to cancel this title request — never ctx.abort()
	// or the primary agent's controller.
	const controller = new AbortController();
	let timedOut = false;
	const cleanups: Array<() => void> = [];

	const localOutcome = (): NamingResult =>
		timedOut
			? { error: `Naming request timed out after ${NAMING_TIMEOUT_MS}ms`, reason: "timeout" }
			: { error: "Naming request cancelled", reason: "cancelled" };

	try {
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, NAMING_TIMEOUT_MS);
		cleanups.push(() => clearTimeout(timeout));

		// ctx.signal is a context getter that can throw once the context has been
		// invalidated; capture it defensively so generateName keeps its
		// "never throws" contract (an explicit options.signal is always safe).
		let externalSignal: AbortSignal | undefined;
		try {
			externalSignal = options?.signal ?? ctx.signal;
		} catch {
			externalSignal = options?.signal;
		}

		const onExternalAbort = (): void => {
			controller.abort();
		};
		if (externalSignal) {
			if (externalSignal.aborted) {
				onExternalAbort();
			} else {
				const signal = externalSignal;
				signal.addEventListener("abort", onExternalAbort, { once: true });
				cleanups.push(() => signal.removeEventListener("abort", onExternalAbort));
			}
		}

		// Pre-aborted upstream signal: settle locally without dispatching.
		if (controller.signal.aborted) return localOutcome();

		// Registered before the provider call so the local deadline/cancellation
		// outcome wins the race even when the provider also reacts to the abort.
		// The listener is named and removed in finally: we never assume the
		// provider drops its retained AbortSignal reference.
		let resolveLocal: (result: NamingResult) => void = () => {};
		const localCancellation = new Promise<NamingResult>((resolve) => {
			resolveLocal = resolve;
		});
		const onLocalAbort = (): void => {
			resolveLocal(localOutcome());
		};
		controller.signal.addEventListener("abort", onLocalAbort, { once: true });
		cleanups.push(() => controller.signal.removeEventListener("abort", onLocalAbort));

		// The provider work always settles (never rejects): a late rejection after
		// cancellation is consumed here and ignored.
		const providerWork = (async (): Promise<NamingResult> => {
			try {
				const resolved = resolveModel(ctx, config);
				if (!resolved.model) return { error: resolved.error ?? "No naming model available" };

				const systemPrompt = buildSystemPrompt(config);
				const userMessage = buildUserPrompt(kind, input, options?.currentName);

				// Registry call: resolves apiKey/headers/baseUrl, then streams through the
				// effective provider (including extension-registered api ids). Auth and
				// provider failures throw here and become { error } below.
				const response = await ctx.modelRegistry.complete(
					resolved.model,
					{ systemPrompt, messages: [userMessage] },
					{ maxTokens: NAMING_MAX_TOKENS, signal: controller.signal },
				);

				if (response.stopReason === "error" || response.stopReason === "aborted") {
					return { error: response.errorMessage ?? `Naming request failed (${response.stopReason})` };
				}

				const raw = response.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n");

				const name = sanitizeName(raw);
				if (!name) {
					return { error: "Naming model returned an empty title" };
				}
				return { name };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		})();

		return await Promise.race([providerWork, localCancellation]);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		// Timer and every listener this request owns are removed on all exit
		// paths: success, provider/auth failure, deadline, cancellation, and
		// pre-aborted input.
		for (const cleanup of cleanups.splice(0)) {
			try {
				cleanup();
			} catch {
				// Cleanup must stay total.
			}
		}
	}
}
