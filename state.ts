/**
 * pi-auto-rename — per-session naming state.
 *
 * Persists whether the current session name was set automatically or manually
 * via pi.appendEntry("pi-auto-rename:state", ...). Custom entries do not
 * participate in LLM context. On session start, readState() restores the
 * latest state so the "manual names are never overwritten" rule survives
 * restarts and resume.
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

export type RenameSource = "auto" | "manual";

export interface RenameState {
	name: string;
	source: RenameSource;
	timestamp: number;
}

export const STATE_ENTRY_TYPE = "pi-auto-rename:state";

/** Append the state as a custom entry (survives reload/resume, not sent to LLM). */
export function writeState(pi: ExtensionAPI, state: RenameState): void {
	pi.appendEntry<RenameState>(STATE_ENTRY_TYPE, state);
}

function isRenameState(data: unknown): data is RenameState {
	if (typeof data !== "object" || data === null) return false;
	const record = data as Record<string, unknown>;
	return (
		typeof record.name === "string" &&
		(record.source === "auto" || record.source === "manual") &&
		typeof record.timestamp === "number"
	);
}

/**
 * Find the latest pi-auto-rename state entry in a session branch.
 * Returns null when absent or malformed.
 */
export function readState(entries: readonly SessionEntry[]): RenameState | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		if (!isRenameState(entry.data)) continue;
		return entry.data;
	}
	return null;
}
