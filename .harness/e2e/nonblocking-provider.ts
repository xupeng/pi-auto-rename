/**
 * E2E helper: a custom-api provider whose title request can be held pending.
 *
 * The extension registers a provider with a custom api id (so the registry path
 * is exercised), a harmless probe tool, and — test-only — a session_info_changed
 * listener that records when pi-auto-rename applies a title.
 *
 * Requests are classified by the naming system-prompt marker, never by a shared
 * response counter, so a naming request and a main request cannot be confused.
 *
 * Env:
 *   E2E_LATCH_DIR     directory for progress.log and latch files
 *   E2E_TITLE_MODE    "release" (wait for release-title, then return a title)
 *                     or "never" (never settle; simulates an abort-ignoring provider)
 *   E2E_WAIT_FOR_TITLE "1" makes the second main request wait for the title latch
 *                      before returning, so print-mode exit cannot race the naming.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isNamingRequest } from "./detect-naming.ts";

const TITLE = "E2E 后台标题";

const LATCH_DIR = process.env.E2E_LATCH_DIR ?? "";
const TITLE_MODE = process.env.E2E_TITLE_MODE ?? "release";
const WAIT_FOR_TITLE = process.env.E2E_WAIT_FOR_TITLE === "1";

function progress(line: string): void {
	appendFileSync(join(LATCH_DIR, "progress.log"), `${line}\n`);
}

function touch(name: string): void {
	writeFileSync(join(LATCH_DIR, name), `${Date.now()}\n`);
}

function waitForFile(name: string, timeoutMs: number): Promise<boolean> {
	const path = join(LATCH_DIR, name);
	const start = Date.now();
	return new Promise((resolve) => {
		const check = (): void => {
			if (existsSync(path)) {
				resolve(true);
				return;
			}
			if (Date.now() - start >= timeoutMs) {
				resolve(false);
				return;
			}
			setTimeout(check, 40);
		};
		check();
	});
}

const probeTool = defineTool({
	name: "e2e_probe",
	label: "E2E probe",
	description: "Records that the agent reached tool execution while the title request was still pending",
	parameters: Type.Object({}),
	async execute() {
		const sawNaming = await waitForFile("naming-started", 20_000);
		if (!sawNaming || existsSync(join(LATCH_DIR, "release-title")) || existsSync(join(LATCH_DIR, "title-applied"))) {
			throw new Error("probe did not observe an unreleased, pending title request");
		}
		progress("tool-saw-naming-pending");
		return { content: [{ type: "text", text: "probe-ok" }], details: undefined };
	},
});

export default function nonblockingProviderExtension(pi: ExtensionAPI): void {
	const faux = fauxProvider({
		provider: "e2enp",
		api: "e2enp-custom-responses",
		models: [{ id: "np-model", name: "NP Model", reasoning: false, input: ["text"] }],
	});

	let mainRequests = 0;

	const respond = async (context: Parameters<typeof isNamingRequest>[0]) => {
		if (isNamingRequest(context)) {
			progress("naming-started");
			touch("naming-started");
			if (TITLE_MODE === "never") {
				return await new Promise<never>(() => {});
			}
			const released = await waitForFile("release-title", 25_000);
			progress(released ? "title-released" : "title-release-timeout");
			return fauxAssistantMessage(TITLE);
		}

		mainRequests += 1;
		if (mainRequests === 1) {
			return fauxAssistantMessage([fauxToolCall("e2e_probe", {})]);
		}
		if (!existsSync(join(LATCH_DIR, "naming-started")) || existsSync(join(LATCH_DIR, "title-applied")) ||
			!context.messages.some((message) => message.role === "toolResult" && message.toolName === "e2e_probe" && !message.isError)) {
			throw new Error("next main request did not observe tool progress while the title was pending");
		}
		progress("main2-started");
		touch("release-title");
		if (WAIT_FOR_TITLE) {
			const applied = await waitForFile("title-applied", 20_000);
			progress(applied ? "main2-saw-title" : "main2-title-timeout");
		}
		return fauxAssistantMessage("done");
	};

	faux.setResponses(Array.from({ length: 20 }, () => respond));
	pi.registerProvider(faux.provider);
	pi.registerTool(probeTool);

	// Test-only latch; pi-auto-rename itself never does this.
	pi.on("session_info_changed", (event) => {
		if (event.name === TITLE) {
			progress("title-applied");
			touch("title-applied");
		}
	});
	pi.on("session_shutdown", () => {
		if (TITLE_MODE === "never" && existsSync(join(LATCH_DIR, "naming-started")) && !existsSync(join(LATCH_DIR, "title-applied"))) {
			progress("shutdown-with-title-pending");
		}
	});
}
