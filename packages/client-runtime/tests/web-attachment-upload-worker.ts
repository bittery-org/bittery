import { serveWebRuntimeWorker } from "../src/web/worker-entry";
import type { RuntimeWasm, WebClientRuntimeLike } from "../src/worker-runtime";

type SeedableRuntime = WebClientRuntimeLike & {
	seedAttachmentUploadTestAuthority(
		serverUrl: string,
		mode: string,
	): Promise<string>;
};

class JoinedUploadRuntime implements WebClientRuntimeLike {
	private constructor(private readonly inner: SeedableRuntime) {}

	static withConfiguredAttachmentMovePreparation(...args: unknown[]) {
		const bindings = (globalThis as { joinedBindings: RuntimeWasm })
			.joinedBindings;
		const construct = bindings.WebClientRuntime
			.withConfiguredAttachmentMovePreparation as unknown as (
			...values: unknown[]
		) => SeedableRuntime;
		const inner = construct.call(bindings.WebClientRuntime, ...args);
		return new JoinedUploadRuntime(inner);
	}

	async open(): Promise<void> {
		await this.inner.open();
		const mode =
			new URL(self.location.href).searchParams.get("mode") ?? "writable";
		const authority = await this.inner.seedAttachmentUploadTestAuthority(
			self.location.origin,
			mode,
		);
		const seeded = await fetch("/upload-authority", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: authority,
		});
		if (!seeded.ok) throw new Error("joined Upload authority setup failed");
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
		clientId: "chromium-joined-upload",
		platform: "web",
		version: "1",
	},
	loadWasm: async () => {
		const bindings = await loadBindings();
		return {
			...bindings,
			WebClientRuntime:
				JoinedUploadRuntime as unknown as RuntimeWasm["WebClientRuntime"],
		};
	},
});
