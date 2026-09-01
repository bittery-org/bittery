import { WebHttpTransportExecutor } from "../src/web-http-transport-executor";

declare global {
	interface Window {
		runVaultImageHttpHarness: (
			url: string,
			headers: Array<{ name: string; value: string }>,
		) => Promise<string>;
	}
}

window.runVaultImageHttpHarness = async (url, headers) => {
	const result = await new WebHttpTransportExecutor().invoke(
		JSON.stringify({
			dispatchId: `browser-${Date.now()}-${Math.random()}`,
			method: "PUT",
			url,
			headers,
			body: [1, 2, 3],
			maxResponseBytes: 64,
		}),
	);
	const parsed = JSON.parse(result) as { type: string; status?: number };
	if (parsed.type !== "completed" || parsed.status !== 200) {
		throw new Error("signed upload rejected");
	}
	return result;
};
