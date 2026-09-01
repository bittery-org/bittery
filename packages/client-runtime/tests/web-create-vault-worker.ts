import { serveWebRuntimeWorker } from "../src/web/worker-entry";
import type { RuntimeWasm, WebClientRuntimeLike } from "../src/worker-runtime";

// Fault injection stays outside the Runtime and its executor: the production Fetch-based
// transport receives a rejected browser network promise, which is the sole path that serializes
// `HttpResponse::NetworkFailure`. The Server decides whether its effect happened before loss.
const browserFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (...args) => {
	const response = await browserFetch(...args);
	if (response.headers.get("x-bittery-test-network-failure") === "1") {
		throw new TypeError("Failed to fetch");
	}
	return response;
};

type SeedableRuntime = WebClientRuntimeLike & {
	seedCreateVaultTestAuthority(
		serverUrl: string,
		pauseCheckpoint?: string,
	): Promise<void>;
};

class JoinedCreateVaultRuntime implements WebClientRuntimeLike {
	private constructor(private readonly inner: SeedableRuntime) {}

	static withConfiguredAttachmentMovePreparation(...args: unknown[]) {
		const bindings = (globalThis as { joinedBindings: RuntimeWasm })
			.joinedBindings;
		const construct = bindings.WebClientRuntime
			.withConfiguredAttachmentMovePreparation as unknown as (
			...values: unknown[]
		) => SeedableRuntime;
		return new JoinedCreateVaultRuntime(
			construct.call(bindings.WebClientRuntime, ...args),
		);
	}

	async open(): Promise<void> {
		await this.inner.open();
		await this.inner.seedCreateVaultTestAuthority(
			self.location.origin,
			new URL(self.location.href).searchParams.get("pause") ?? undefined,
		);
	}
	request_json(requestId: string, requestJson: string): Promise<string> {
		return this.inner.request_json(requestId, requestJson);
	}
	observe_json(
		observationId: string,
		requestJson: string,
		listener: (projectionJson: string) => void,
	): void {
		this.inner.observe_json(observationId, requestJson, listener);
	}
	unobserve(observationId: string): void {
		this.inner.unobserve(observationId);
	}
	cancel(requestId: string): void {
		this.inner.cancel(requestId);
	}
	close(): Promise<void> {
		return Promise.resolve(this.inner.close());
	}
}

type GeneratedBindings = RuntimeWasm & {
	default(options: { module_or_path: string }): Promise<unknown>;
};

let bindingsTask: Promise<GeneratedBindings> | undefined;
const loadBindings = (): Promise<GeneratedBindings> => {
	bindingsTask ??= (async () => {
		const bindingsUrl = "/real-core-bindings.js";
		const generated = (await import(
			bindingsUrl
		)) as unknown as GeneratedBindings;
		await generated.default({ module_or_path: "/real-core.wasm" });
		(globalThis as { joinedBindings: RuntimeWasm }).joinedBindings = generated;
		return generated;
	})();
	return bindingsTask;
};

serveWebRuntimeWorker(self, {
	authClient: {
		clientId: "chromium-create-vault",
		platform: "web",
		version: "1",
	},
	loadWasm: async () => ({
		...(await loadBindings()),
		WebClientRuntime:
			JoinedCreateVaultRuntime as unknown as RuntimeWasm["WebClientRuntime"],
	}),
});
