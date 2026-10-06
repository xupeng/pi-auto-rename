/**
 * E2E helper: a provider that behaves like @router-for-me/pi-cliproxyapi-provider.
 *
 * It registers a provider whose models carry a *custom* api id
 * ("fauxapi-custom-responses") implemented by the extension's own streamSimple.
 * That api id never exists in pi-ai's global api registry, so any code path that
 * dispatches through @earendil-works/pi-ai/compat fails with
 * "No API provider registered for api: fauxapi-custom-responses".
 *
 * Because automatic naming is now non-blocking, the title is produced on a later
 * event-loop turn and print mode may dispose (cancelling a pending title) as
 * soon as the turn completes. The provider therefore runs two main requests: the
 * first asks for a harmless probe tool, and the second waits until the background
 * title has been applied before returning "ok". The wait belongs only to the test
 * provider, never to product handlers.
 */
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isNamingRequest } from "./detect-naming.ts";

const EXPECTED_TITLE = "Faux 自定义 API 标题";

const probeTool = defineTool({
	name: "e2e_probe",
	label: "E2E probe",
	description: "Keeps the turn alive between the first and second model request",
	parameters: Type.Object({}),
	async execute() {
		return { content: [{ type: "text", text: "probe-ok" }], details: undefined };
	},
});

export default function fauxProviderExtension(pi: ExtensionAPI): void {
	const faux = fauxProvider({
		provider: "fauxapi",
		api: "fauxapi-custom-responses",
		models: [{ id: "naming-model", name: "Faux Custom API Model", reasoning: false, input: ["text"] }],
	});

	let mainRequests = 0;

	const respond = async (context: Parameters<typeof isNamingRequest>[0]) => {
		if (isNamingRequest(context)) return fauxAssistantMessage(EXPECTED_TITLE);
		mainRequests += 1;
		if (mainRequests === 1) return fauxAssistantMessage([fauxToolCall("e2e_probe", {})]);
		// Wait for the background title so print-mode shutdown cannot cancel it.
		const deadline = Date.now() + 10_000;
		while (pi.getSessionName() !== EXPECTED_TITLE && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		return fauxAssistantMessage("ok");
	};

	faux.setResponses(Array.from({ length: 10 }, () => respond));
	pi.registerProvider(faux.provider);
	pi.registerTool(probeTool);
}
