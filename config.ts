/**
 * pi-auto-rename — global configuration.
 *
 * Reads/writes <agentDir>/pi-auto-rename.json (~/.pi/agent/pi-auto-rename.json)
 * with the normalized RenameConfig structure. On disk, `model` accepts either a
 * single `{ provider, id }` / `"provider/id"` or an ordered array of them for
 * fallback. Any read/parse failure falls back to defaults so the extension
 * stays zero-config out of the box.
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
	/**
	 * Ordered naming model overrides. Empty means "follow the session's current model".
	 */
	models: RenameModelRef[];
	/** Legacy single-model override accepted when callers pass ad-hoc config objects. */
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
		models: [],
		style: "concise",
		autoRename: true,
		continuousRename: false,
		language: "auto",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse `"provider/id"` (allowing slashes inside `id`, e.g. `"openrouter/org/model"`). */
export function parseModelRef(value: string): RenameModelRef | null {
	const input = value.trim();
	const slashIndex = input.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= input.length - 1) return null;
	const rawProvider = input.slice(0, slashIndex);
	const rawId = input.slice(slashIndex + 1);
	const provider = rawProvider.trim();
	const id = rawId.trim();
	if (!provider || !id || provider !== rawProvider || id !== rawId) return null;
	return { provider, id };
}

/** Parse comma-separated `"provider/id,provider2/id2"` into a deduplicated list; null on any invalid entry. */
export function parseModelRefs(value: string): RenameModelRef[] | null {
	const parts = value.split(",");
	const refs: RenameModelRef[] = [];
	for (const part of parts) {
		const ref = parseModelRef(part);
		if (!ref) return null;
		refs.push(ref);
	}
	return dedupeModelRefs(refs);
}

export function formatModelRef(ref: RenameModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

export function formatModelRefs(models?: readonly RenameModelRef[]): string {
	if (!models || models.length === 0) return "follow session model";
	return models.map(formatModelRef).join(" → ");
}

export function getConfiguredModels(config: Pick<RenameConfig, "models" | "model">): RenameModelRef[] {
	if (Array.isArray(config.models) && config.models.length > 0) {
		return dedupeModelRefs(config.models);
	}
	if (config.model) {
		const single = normalizeSingleModelRef(config.model);
		return single ? [single] : [];
	}
	return [];
}

export function formatConfigSummary(config: RenameConfig): string {
	const models = getConfiguredModels(config);
	const model = formatModelRefs(models);
	const custom = config.style === "custom" ? ` (${config.customStyle ?? ""})` : "";
	return (
		`model: ${model}; style: ${config.style}${custom}; auto: ${config.autoRename ? "on" : "off"}; ` +
		`continuous: ${config.continuousRename ? "on" : "off"}; language: ${config.language}`
	);
}

export function dedupeModelRefs(refs: readonly RenameModelRef[]): RenameModelRef[] {
	const out: RenameModelRef[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const key = formatModelRef(ref);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ provider: ref.provider, id: ref.id });
	}
	return out;
}

function normalizeSingleModelRef(value: unknown): RenameModelRef | undefined {
	if (typeof value === "string") {
		return parseModelRef(value) ?? undefined;
	}
	if (!isRecord(value)) return undefined;
	const { provider, id } = value;
	if (typeof provider !== "string" || typeof id !== "string") return undefined;
	const normalizedProvider = provider.trim();
	const normalizedId = id.trim();
	if (!normalizedProvider || !normalizedId) return undefined;
	return { provider: normalizedProvider, id: normalizedId };
}

function normalizeModelRefs(value: unknown): RenameModelRef[] {
	if (Array.isArray(value)) {
		const refs: RenameModelRef[] = [];
		for (const item of value) {
			const normalized = normalizeSingleModelRef(item);
			if (normalized) refs.push(normalized);
		}
		return dedupeModelRefs(refs);
	}
	const single = normalizeSingleModelRef(value);
	return single ? [single] : [];
}

function normalizeConfig(data: unknown): RenameConfig {
	const base = defaultConfig();
	if (!isRecord(data)) return base;

	const out: RenameConfig = { ...base, models: [] };
	out.models = normalizeModelRefs(data.model);
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
		const models = getConfiguredModels(config);
		const persisted: Record<string, unknown> = {
			...(models.length === 1 ? { model: models[0] } : models.length > 1 ? { model: models } : {}),
			style: config.style,
			...(config.customStyle ? { customStyle: config.customStyle } : {}),
			autoRename: config.autoRename,
			continuousRename: config.continuousRename,
			language: config.language,
		};
		mkdirSync(dirname(CONFIG_FILE_PATH), { recursive: true });
		writeFileSync(CONFIG_FILE_PATH, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
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
