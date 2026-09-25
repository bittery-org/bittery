import { serveWebRuntimeWorker } from "../src/web/worker-entry";
import type {
	RuntimeWasm,
	VaultImageSourceExecutor,
	WebClientRuntimeLike,
} from "../src/worker-runtime";

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
	seedAttachmentUploadTestAuthority(
		serverUrl: string,
		mode: string,
	): Promise<string>;
	seedVaultRetirementTestHistory(
		serverUrl: string,
		artifacts: unknown,
		ready: (history: string) => void,
	): Promise<void>;
	setRecoveryExecutor: NonNullable<WebClientRuntimeLike["setRecoveryExecutor"]>;
	seedCreateVaultTestAuthority(
		serverUrl: string,
		pauseCheckpoint?: string,
		secondAccount?: boolean,
	): Promise<void>;
};

class JoinedCreateVaultRuntime implements WebClientRuntimeLike {
	private constructor(
		private readonly inner: SeedableRuntime,
		private readonly images: VaultImageSourceExecutor,
		private readonly artifacts: unknown,
	) {}

	static withConfiguredAttachmentMovePreparation(
		...args: Parameters<
			NonNullable<
				RuntimeWasm["WebClientRuntime"]["withConfiguredAttachmentMovePreparation"]
			>
		>
	) {
		const bindings = (globalThis as { joinedBindings: RuntimeWasm })
			.joinedBindings;
		const construct = bindings.WebClientRuntime
			.withConfiguredAttachmentMovePreparation as unknown as (
			...values: unknown[]
		) => SeedableRuntime;
		return new JoinedCreateVaultRuntime(
			construct.call(bindings.WebClientRuntime, ...args),
			args[15],
			args[4],
		);
	}

	setRecoveryExecutor(
		...args: Parameters<SeedableRuntime["setRecoveryExecutor"]>
	): void {
		this.inner.setRecoveryExecutor(...args);
	}

	async open(): Promise<void> {
		const retirement = new URL(self.location.href).searchParams.get(
			"vaultRetirement",
		);
		try {
			await this.inner.open();
		} catch (error) {
			if (retirement !== null)
				await fetch("/retirement-open-error", {
					method: "POST",
					body: String(error),
				});
			throw error;
		}
		if (
			retirement === "restore" ||
			new URL(self.location.href).searchParams.get("recoveryRestore") === "1"
		)
			return;
		if (retirement === "seed") {
			await this.inner.seedVaultRetirementTestHistory(
				self.location.origin,
				this.artifacts,
				(history) => {
					void fetch("/retirement-history", { method: "POST", body: history });
				},
			);
			return;
		}
		if (
			new URL(self.location.href).searchParams.get("archiveAttachment") === "1"
		) {
			const authority = await this.inner.seedAttachmentUploadTestAuthority(
				self.location.origin,
				"writable",
			);
			const response = await fetch("/archive-item-authority", {
				method: "POST",
				body: authority,
			});
			if (!response.ok) throw new Error("Archive Item authority setup failed");
		}
		await this.inner.seedCreateVaultTestAuthority(
			self.location.origin,
			new URL(self.location.href).searchParams.get("pause") ?? undefined,
			new URL(self.location.href).searchParams.get("secondAccount") === "1",
		);
	}
	request_json(requestId: string, requestJson: string): Promise<string> {
		// This capability-only probe forwards closed controls through the real Worker host channel.
		// It is not a Core visibility/retirement policy decision.
		if (requestJson.startsWith("image-control:")) {
			return this.images
				.invoke(requestJson.slice("image-control:".length))
				.then((answer) => {
					answer.binaryChunk?.fill(0);
					return answer.controlResponseJson;
				});
		}
		return this.inner.request_json(requestId, requestJson);
	}
	observe_json(
		observationId: string,
		requestJson: string,
		listener: (projectionJson: string) => void,
		controlCallback?: (controlJson: string) => void,
	): void {
		const probe =
			new URL(self.location.href).searchParams.get("exportOutput") === "1" &&
			JSON.parse(requestJson).type === "vaultExport";
		const witness = (phase: "before" | "after") => {
			let result = "admitted";
			try {
				this.inner.begin_vault_export_output(observationId);
			} catch (error) {
				result = String(error).includes(
					"Export output is unavailable on this observation",
				)
					? "refused"
					: "unexpected-error";
			}
			// Nonsecret calibration only; the ordinary Worker router ignores this test message.
			self.postMessage({ type: "fixtureExportForwarding", phase, result });
		};
		this.inner.observe_json(
			observationId,
			requestJson,
			probe
				? (json) => {
						witness("before");
						listener(json);
						witness("after");
					}
				: listener,
			new URL(self.location.href).searchParams.get("exportThrow") === "1" &&
				JSON.parse(requestJson).type === "vaultExport"
				? (controlJson) => {
						// Real delayed WASM callback, deliberately failed before host delivery.
						self.postMessage({
							type: "fixtureExportCallbackThrow",
							observationId,
							controlJson,
						});
						throw new Error("joined Export terminal callback failure");
					}
				: controlCallback,
		);
	}
	begin_vault_export_output(observationId: string): string {
		return this.inner.begin_vault_export_output(observationId);
	}
	finish_vault_export_output(
		observationId: string,
		outputLeaseId: string,
	): void {
		this.inner.finish_vault_export_output(observationId, outputLeaseId);
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

// Only this real Worker fixture can request the abrupt error history. The production router
// ignores the unknown envelope; its ordinary onerror owner must retire the live Runtime realm.
if (new URL(self.location.href).searchParams.get("exportLoss") === "1") {
	self.addEventListener("message", (event) => {
		if (event.data?.type === "fixtureExportOwnerLoss")
			throw new Error("joined Export owner loss");
	});
}
