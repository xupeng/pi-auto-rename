/**
 * pi-auto-rename — interactive /rename-config wizard (TUI).
 *
 * Mirrors pi-image's interactive config UX: a main menu whose entries lead
 * to per-item pickers, including a searchable model picker (Input + SelectList
 * with substring filtering). Argument-driven subcommands (/rename-config model
 * provider/id, style concise, ...) remain the fast path and the UI-less
 * fallback; this module only runs when ctx.hasUI is true.
 */

import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import {
	CONFIG_FILE_PATH,
	type RenameConfig,
	type RenameLanguage,
	type RenameStyle,
} from "./config.ts";

/** What the wizard needs from the caller — keeps this module decoupled. */
export interface ConfigUiDeps {
	getConfig(): RenameConfig;
	applyConfig(patch: Partial<RenameConfig>, summary: string): void;
	collectModelRefs(): string[];
	resetConfig(): boolean;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

/** Simple single-select picker (no search). Returns null on cancel. */
function pickOne<T extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
): Promise<T | null> {
	return ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title))));
		const list = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (str) => theme.fg("accent", str),
			selectedText: (str) => theme.fg("accent", str),
			description: (str) => theme.fg("muted", str),
			scrollInfo: (str) => theme.fg("dim", str),
			noMatch: (str) => theme.fg("warning", str),
		});
		list.onSelect = (item) => done(item.value as T);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/**
 * Model picker with substring search over provider/id and id (mirrors
 * pi-image's pickModel). `refs` are "provider/id" strings; a trailing
 * "none" entry clears the override. Returns null on cancel.
 */
function pickModel(
	ctx: ExtensionCommandContext,
	title: string,
	refs: string[],
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const kb = getKeybindings();
		const root = new Container();
		root.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		root.addChild(new Text(theme.fg("accent", theme.bold(title))));
		root.addChild(new Text(theme.fg("muted", "Search:")));
		const search = new Input();
		root.addChild(search);
		const listBox = new Container();
		root.addChild(listBox);

		let list: SelectList;
		let lastValue: string | undefined;

		const buildItems = (query: string): SelectItem[] => {
			const q = query.trim().toLowerCase();
			return refs
				.filter((ref) => !q || ref.toLowerCase().includes(q))
				.map((ref) => ({
					value: ref,
					label: ref === "none" ? "follow session model (clear override)" : ref,
				}));
		};

		const rebuild = () => {
			const items = buildItems(search.getValue());
			const next = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (str) => theme.fg("accent", str),
				selectedText: (str) => theme.fg("accent", str),
				description: (str) => theme.fg("muted", str),
				scrollInfo: (str) => theme.fg("dim", str),
				noMatch: (str) => theme.fg("warning", str),
			});
			next.onSelect = (item) => done(item.value);
			next.onCancel = () => done(null);
			next.onSelectionChange = (item) => {
				lastValue = item.value;
			};
			const idx = lastValue ? items.findIndex((item) => item.value === lastValue) : -1;
			if (idx >= 0) next.setSelectedIndex(idx);
			list = next;
			listBox.clear();
			listBox.addChild(list);
		};

		rebuild();
		root.addChild(
			new Text(theme.fg("dim", "type to search · ↑↓ navigate · enter select · esc cancel")),
		);
		root.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render: (width) => root.render(width),
			invalidate: () => root.invalidate(),
			handleInput: (data) => {
				const isNav =
					kb.matches(data, "tui.select.up") ||
					kb.matches(data, "tui.select.down") ||
					kb.matches(data, "tui.select.confirm") ||
					kb.matches(data, "tui.select.cancel");
				if (isNav) {
					list.handleInput(data);
					const selected = list.getSelectedItem();
					if (selected) lastValue = selected.value;
				} else {
					search.handleInput(data);
					rebuild();
				}
				tui.requestRender();
			},
		};
	});
}

function summarize(config: RenameConfig): string {
	const model = config.model ? `${config.model.provider}/${config.model.id}` : "follow session model";
	const custom = config.style === "custom" ? ` (${config.customStyle ?? ""})` : "";
	return (
		`model: ${model}; style: ${config.style}${custom}; auto: ${config.autoRename ? "on" : "off"}; ` +
		`continuous: ${config.continuousRename ? "on" : "off"}; language: ${config.language}`
	);
}

/**
 * Interactive wizard. Assumes ctx.hasUI (guarded by the caller).
 *
 * Loops back to the main menu after each item is configured (the summary in
 * the title reflects the latest config), until the user picks "done" or
 * cancels. Escaping a sub-picker also returns to the main menu, not out of
 * the wizard.
 */
export async function runInteractiveConfig(
	ctx: ExtensionCommandContext,
	deps: ConfigUiDeps,
): Promise<void> {
	while (true) {
		const choice = await ctx.ui.select(
			`Rename config — ${summarize(deps.getConfig())}`,
			["model", "style", "auto", "continuous", "language", "show", "reset", "done"],
		);
		if (!choice || choice === "done") return;

		switch (choice) {
		case "model": {
			const refs = deps.collectModelRefs();
			if (refs.length === 0) {
				deps.notify("No models with configured auth are available.", "warning");
				break;
			}
			const selected = await pickModel(ctx, "Select rename model:", [...refs, "none"]);
			if (selected === null) break;
			if (selected === "none") {
				deps.applyConfig({ model: undefined }, "Rename model cleared (follows session model)");
			} else {
				const slash = selected.indexOf("/");
				if (slash > 0) {
					deps.applyConfig(
						{
							model: {
								provider: selected.slice(0, slash),
								id: selected.slice(slash + 1),
							},
						},
						`Rename model set to ${selected}`,
					);
				}
			}
			break;
		}
		case "style": {
			const style = await pickOne<RenameStyle>(ctx, "Select style:", [
				{ value: "concise", label: "Concise" },
				{ value: "formal", label: "Formal" },
				{ value: "playful", label: "Playful" },
				{ value: "custom", label: "Custom (describe it)" },
			]);
			if (!style) break;
			if (style === "custom") {
				const description = await ctx.ui.input(
					"Custom style description:",
					"e.g. Short and punchy",
				);
				if (!description || !description.trim()) break;
				deps.applyConfig(
					{ style, customStyle: description.trim() },
					`Rename style set to custom (${description.trim()})`,
				);
				break;
			}
			deps.applyConfig({ style, customStyle: undefined }, `Rename style set to ${style}`);
			break;
		}
		case "auto": {
			const value = await pickOne<"on" | "off">(ctx, "Auto rename:", [
				{ value: "on", label: "on" },
				{ value: "off", label: "off" },
			]);
			if (!value) break;
			deps.applyConfig({ autoRename: value === "on" }, `Auto rename: ${value}`);
			break;
		}
		case "continuous": {
			const value = await pickOne<"on" | "off">(ctx, "Continuous rename:", [
				{ value: "on", label: "on" },
				{ value: "off", label: "off" },
			]);
			if (!value) break;
			deps.applyConfig({ continuousRename: value === "on" }, `Continuous rename: ${value}`);
			break;
		}
		case "language": {
			const language = await pickOne<RenameLanguage>(ctx, "Title language:", [
				{ value: "auto", label: "auto (follow the conversation)" },
				{ value: "zh", label: "zh (always Chinese)" },
				{ value: "en", label: "en (always English)" },
			]);
			if (!language) break;
			deps.applyConfig({ language }, `Rename title language set to ${language}`);
			break;
		}
		case "show": {
			deps.notify(`Rename config — ${summarize(deps.getConfig())}`, "info");
			deps.notify(`Config file: ${CONFIG_FILE_PATH}`, "info");
			break;
		}
		case "reset": {
			const ok = await ctx.ui.confirm(
				"Reset rename config?",
				"Delete pi-auto-rename.json and restore defaults?",
			);
			if (!ok) break;
			if (deps.resetConfig()) {
				deps.notify("Rename config reset to defaults.", "info");
			} else {
				deps.notify("Failed to delete the config file (runtime defaults applied).", "warning");
			}
			break;
		}
		}
	}
}
