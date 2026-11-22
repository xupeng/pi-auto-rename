/**
 * pi-auto-rename — naming core.
 *
 * Resolves the naming model chain (config override list, or the session's
 * current model when unconfigured), builds system/user prompts for the three
 * naming kinds (first / history / update), calls the AI through
 * ctx.modelRegistry.streamSimple() (passing `reasoning: "minimal"` for
 * reasoning models so thinking cannot exhaust the token budget, and falling
 * back to ctx.modelRegistry.complete() when a mock/older registry lacks
 * streamSimple), and sanitizes the raw output into a short title. All failures
 * are returned as { error } — never thrown.
 *
 * Fallback rules:
 * - Advances to the next configured candidate only on missing model, auth or
 *   provider throw, `stopReason === "error"`, or per-candidate 30s timeout.
 * - External cancellation immediately stops the chain without touching later
 *   candidates.
 * - Any valid model response (`stopReason !== "error" && stopReason !== "aborted"`),
 *   even if empty or sanitized to null, stops immediately to avoid duplicate billing.
 * - When an explicit model override is configured, never falls back to ctx.model.
 */

import type { Api, AssistantMessage, Context, Model, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatModelRef, getConfiguredModels, type RenameConfig } from "./config.ts";

export type NamingKind = "first" | "history" | "update";

export const MAX_TITLE_LENGTH = 80;
export const NAMING_MAX_TOKENS = 128;
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

/** Resolve the primary model to use for naming (preserved for compatibility). */
export function resolveModel(ctx: ExtensionContext, config: RenameConfig): { model?: Model<Api>; error?: string } {
	const overrides = getConfiguredModels(config);
	if (overrides.length > 0) {
		for (const ref of overrides) {
			const model = ctx.modelRegistry.find(ref.provider, ref.id);
			if (model) return { model };
		}
		return { error: `Rename model not found: ${overrides.map(formatModelRef).join(", ")}` };
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

type AttemptOutcome =
	| { kind: "response"; response: AssistantMessage }
	| { kind: "cancelled" }
	| { kind: "failed"; error: string; reason?: "timeout" };

async function callNamingProvider(
	ctx: ExtensionContext,
	model: Model<Api>,
	context: Context,
	signal: AbortSignal,
): Promise<AssistantMessage> {
	const registry = ctx.modelRegistry as ExtensionContext["modelRegistry"] & {
		streamSimple?: ExtensionContext["modelRegistry"]["streamSimple"];
	};
	if (typeof registry.streamSimple === "function") {
		return await registry
			.streamSimple(model, context, {
				maxTokens: NAMING_MAX_TOKENS,
				signal,
				...(model.reasoning ? { reasoning: "minimal" as const } : {}),
			})
			.result();
	}
	return await registry.complete(model, context, {
		maxTokens: NAMING_MAX_TOKENS,
		signal,
	});
}

async function runSingleAttempt(
	ctx: ExtensionContext,
	model: Model<Api>,
	context: Context,
	externalSignal?: AbortSignal,
): Promise<AttemptOutcome> {
	// Every attempt owns a request-specific controller and an independent 30s
	// deadline, whether or not an upstream signal exists: a provider that ignores
	// abort must not be able to keep the extension's request pending forever.
	// The controller is only used to cancel this title request — never ctx.abort()
	// or the primary agent's controller.
	const controller = new AbortController();
	let timedOut = false;
	const cleanups: Array<() => void> = [];

	const localFailure = (): AttemptOutcome =>
		timedOut
			? { kind: "failed", error: `Naming request timed out after ${NAMING_TIMEOUT_MS}ms`, reason: "timeout" }
			: { kind: "cancelled" };

	try {
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, NAMING_TIMEOUT_MS);
		cleanups.push(() => clearTimeout(timeout));

		const onExternalAbort = (): void => {
			controller.abort();
		};
		if (externalSignal) {
			if (externalSignal.aborted) {
				return { kind: "cancelled" };
			}
			externalSignal.addEventListener("abort", onExternalAbort, { once: true });
			cleanups.push(() => externalSignal.removeEventListener("abort", onExternalAbort));
		}

		if (controller.signal.aborted) return localFailure();

		// Registered before the provider call so the local deadline/cancellation
		// outcome wins the race even when the provider also reacts to the abort.
		let resolveLocal: (outcome: AttemptOutcome) => void = () => {};
		const localCancellation = new Promise<AttemptOutcome>((resolve) => {
			resolveLocal = resolve;
		});
		const onLocalAbort = (): void => {
			resolveLocal(localFailure());
		};
		controller.signal.addEventListener("abort", onLocalAbort, { once: true });
		cleanups.push(() => controller.signal.removeEventListener("abort", onLocalAbort));

		// The provider work always settles (never rejects): a late rejection after
		// cancellation is consumed here and ignored.
		const providerWork = (async (): Promise<AttemptOutcome> => {
			try {
				const response = await callNamingProvider(ctx, model, context, controller.signal);
				if (externalSignal?.aborted) return { kind: "cancelled" };
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					if (response.stopReason === "aborted" && timedOut) {
						return { kind: "failed", error: `Naming request timed out after ${NAMING_TIMEOUT_MS}ms`, reason: "timeout" };
					}
					return { kind: "failed", error: response.errorMessage ?? `Naming request failed (${response.stopReason})` };
				}
				return { kind: "response", response };
			} catch (error) {
				if (externalSignal?.aborted) return { kind: "cancelled" };
				if (timedOut) {
					return { kind: "failed", error: `Naming request timed out after ${NAMING_TIMEOUT_MS}ms`, reason: "timeout" };
				}
				return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
			}
		})();

		return await Promise.race([providerWork, localCancellation]);
	} catch (error) {
		return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
	} finally {
		for (const cleanup of cleanups.splice(0)) {
			try {
				cleanup();
			} catch {
				// Cleanup must stay total.
			}
		}
	}
}

/**
 * Generate a title for the given input using the resolved naming model chain.
 * Returns { name } on success or { error } on any failure — never throws.
 */
export async function generateName(
	ctx: ExtensionContext,
	config: RenameConfig,
	kind: NamingKind,
	input: string,
	options?: NamingOptions,
): Promise<NamingResult> {
	try {
		// ctx.signal is a context getter that can throw once the context has been
		// invalidated; capture it defensively so generateName keeps its
		// "never throws" contract (an explicit options.signal is always safe).
		let externalSignal: AbortSignal | undefined;
		try {
			externalSignal = options?.signal ?? ctx.signal;
		} catch {
			externalSignal = options?.signal;
		}

		if (externalSignal?.aborted) {
			return { error: "Naming request cancelled", reason: "cancelled" };
		}

		const overrides = getConfiguredModels(config);
		const candidates: Array<{ label: string; model?: Model<Api>; missingError?: string }> = [];
		if (overrides.length > 0) {
			for (const ref of overrides) {
				const label = formatModelRef(ref);
				const found = ctx.modelRegistry.find(ref.provider, ref.id);
				candidates.push(
					found
						? { label, model: found }
						: { label, missingError: `Rename model not found: ${label}` },
				);
			}
		} else if (ctx.model) {
			candidates.push({ label: `${ctx.model.provider}/${ctx.model.id}`, model: ctx.model });
		} else {
			return { error: "No active session model available for naming" };
		}

		const systemPrompt = buildSystemPrompt(config);
		const userMessage = buildUserPrompt(kind, input, options?.currentName);
		const context: Context = { systemPrompt, messages: [userMessage] };

		const failures: Array<{ label: string; error: string; reason?: "timeout" }> = [];
		for (const candidate of candidates) {
			if (externalSignal?.aborted) {
				return { error: "Naming request cancelled", reason: "cancelled" };
			}
			if (!candidate.model) {
				failures.push({ label: candidate.label, error: candidate.missingError ?? `Rename model not found: ${candidate.label}` });
				continue;
			}
			const attempt = await runSingleAttempt(ctx, candidate.model, context, externalSignal);
			if (attempt.kind === "cancelled") {
				return { error: "Naming request cancelled", reason: "cancelled" };
			}
			if (attempt.kind === "failed") {
				failures.push({ label: candidate.label, error: attempt.error, ...(attempt.reason ? { reason: attempt.reason } : {}) });
				continue;
			}

			// Valid response received: stop immediately even if empty/unusable so we never double-bill.
			const raw = attempt.response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");

			const name = sanitizeName(raw);
			if (!name) {
				return { error: "Naming model returned an empty title" };
			}
			return { name };
		}

		if (failures.length === 1) {
			const only = failures[0]!;
			return { error: only.error, ...(only.reason ? { reason: only.reason } : {}) };
		}
		const allTimeout = failures.length > 0 && failures.every((failure) => failure.reason === "timeout");
		return {
			error: failures.map((failure) => `${failure.label}: ${failure.error}`).join("; "),
			...(allTimeout ? { reason: "timeout" as const } : {}),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
