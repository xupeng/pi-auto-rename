/**
 * pi-auto-rename — global configuration.
 *
 * Reads/writes <agentDir>/pi-auto-rename.json (~/.pi/agent/pi-auto-rename.json)
 * with the full RenameConfig structure. Any read/parse failure falls back to
 * defaults so the extension stays zero-config out of the box.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type RenameStyle = "concise" | "formal" | "playful" | "custom";
export type RenameLanguage = "auto" | "zh" | "en";

export interface RenameModelRef {
	provider: string;
	id: string;
}

export interface RenameConfig {
	/** Naming model override; undefined means "follow the session's current model". */
	model?: RenameModelRef;
	/** Naming style. Default "concise". */
	style: RenameStyle;
	/** Free-form style description, used only when style === "custom". */
	customStyle?: string;
	/** Master switch for automatic naming. Default true. */
	autoRename: boolean;
	/** Continuous re-naming on topic shift. Default false. */
	continuousRename: boolean;
	/** Title language: "auto" follows the conversation; "zh"/"en" force it. */
	language: RenameLanguage;
}

/** Config location: <agentDir>/pi-auto-rename.json. */
export const CONFIG_FILE_PATH = join(getAgentDir(), "pi-auto-rename.json");

const STYLES: readonly RenameStyle[] = ["concise", "formal", "playful", "custom"];
const LANGUAGES: readonly RenameLanguage[] = ["auto", "zh", "en"];

export function defaultConfig(): RenameConfig {
	return {
		style: "concise",
		autoRename: true,
		continuousRename: false,
		language: "auto",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelRef(value: unknown): RenameModelRef | undefined {
	if (!isRecord(value)) return undefined;
	const { provider, id } = value;
	if (typeof provider !== "string" || typeof id !== "string") return undefined;
	const normalizedProvider = provider.trim();
	const normalizedId = id.trim();
	if (!normalizedProvider || !normalizedId) return undefined;
	return { provider: normalizedProvider, id: normalizedId };
}

function normalizeConfig(data: unknown): RenameConfig {
	const base = defaultConfig();
	if (!isRecord(data)) return base;

	const out: RenameConfig = { ...base };
	const model = normalizeModelRef(data.model);
	if (model) out.model = model;
	if (typeof data.style === "string" && (STYLES as readonly string[]).includes(data.style)) {
		out.style = data.style as RenameStyle;
	}
	if (typeof data.customStyle === "string" && data.customStyle.trim()) {
		out.customStyle = data.customStyle.trim();
	}
	if (typeof data.autoRename === "boolean") out.autoRename = data.autoRename;
	if (typeof data.continuousRename === "boolean") out.continuousRename = data.continuousRename;
	if (typeof data.language === "string" && (LANGUAGES as readonly string[]).includes(data.language)) {
		out.language = data.language as RenameLanguage;
	}
	return out;
}

/**
 * Load the persisted config; returns defaults on any read/parse failure.
 */
export function loadConfig(): RenameConfig {
	try {
		const content = readFileSync(CONFIG_FILE_PATH, "utf8");
		const parsed = JSON.parse(content) as unknown;
		return normalizeConfig(parsed);
	} catch {
		return defaultConfig();
	}
}

/** Persist the config. Returns false on failure (caller keeps memory config). */
export function saveConfig(config: RenameConfig): boolean {
	try {
		mkdirSync(dirname(CONFIG_FILE_PATH), { recursive: true });
		writeFileSync(CONFIG_FILE_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** Delete the config file; missing file counts as success. */
export function resetConfigFile(): boolean {
	try {
		rmSync(CONFIG_FILE_PATH, { force: true });
		return true;
	} catch {
		return false;
	}
}
