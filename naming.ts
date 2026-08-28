/**
 * pi-auto-rename — naming core.
 *
 * Resolves the naming model (config override, or the session's current model),
 * builds system/user prompts for the three naming kinds (first / history /
 * update), calls the AI via @earendil-works/pi-ai/compat (complete), and
 * sanitizes the raw output into a short title. All failures are returned as
 * { error } — never thrown.
 *
 * The @earendil-works/pi-ai/compat import is the single coupling point to the
 * pi-ai version: complete() moved to the /compat subpath in pi-ai 0.84.
 */

import { complete } from "@earendil-works/pi-ai/compat";
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
	/** Abort signal forwarded to the provider request. */
	signal?: AbortSignal;
}

export interface NamingResult {
	name?: string;
	error?: string;
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

export interface ResolvedAuth {
	ok: boolean;
	apiKey?: string;
	headers?: Record<string, string | null>;
	error?: string;
}

/** Resolve API key + headers for the naming model. */
export async function getAuth(ctx: ExtensionContext, model: Model<Api>): Promise<ResolvedAuth> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { ok: false, error: auth.error };
	}
	if (!auth.apiKey) {
		return { ok: false, error: `No API key configured for ${model.provider}. Use /login or models.json.` };
	}
	return { ok: true, apiKey: auth.apiKey, headers: auth.headers };
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
	const externalSignal = options?.signal ?? ctx.signal;
	let controller: AbortController | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let signal = externalSignal;
	if (!signal) {
		// No abort source available: own the cancellation so a hung request
		// cannot wedge the single-flight guard (inFlight) forever.
		controller = new AbortController();
		timeout = setTimeout(() => controller?.abort(), NAMING_TIMEOUT_MS);
		signal = controller.signal;
	}
	try {
		const resolved = resolveModel(ctx, config);
		if (!resolved.model) return { error: resolved.error ?? "No naming model available" };

		const auth = await getAuth(ctx, resolved.model);
		if (!auth.ok) return { error: auth.error ?? "No API key available for the naming model" };

		const systemPrompt = buildSystemPrompt(config);
		const userMessage = buildUserPrompt(kind, input, options?.currentName);

		const response = await complete(
			resolved.model,
			{ systemPrompt, messages: [userMessage] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: NAMING_MAX_TOKENS,
				signal,
			},
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
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}
