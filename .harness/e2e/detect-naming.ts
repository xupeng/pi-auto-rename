/**
 * Shared E2E helper: classify a provider request as a naming request.
 *
 * In the composed runtime the provider receives a normalized TranscriptContext
 * whose leading prompt lives in a `system` message — there is no
 * `context.systemPrompt` field. Classifying by that missing field made every
 * request look like a main request, so scan the system messages instead.
 */
import { getSystemMessageText, type TranscriptContext } from "@earendil-works/pi-ai";

export const NAMING_PROMPT_MARKER = "You create short, descriptive titles";

export function isNamingRequest(context: TranscriptContext): boolean {
	return context.messages.some(
		(message) => message.role === "system" && getSystemMessageText(message).includes(NAMING_PROMPT_MARKER),
	);
}
