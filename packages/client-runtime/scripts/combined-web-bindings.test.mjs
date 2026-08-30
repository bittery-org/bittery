import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const combinedRoot =
	process.env.BITTERY_COMBINED_WEB_BINDINGS_ROOT ??
	resolve(scriptRoot, "../../crypto/wasm/generated/wasm-bindgen");
const standaloneRoot = resolve(scriptRoot, "../generated/web");

const unavailableDownloadSink = () => ({
	invoke: async (controlRequestJson) => {
		const type = JSON.parse(controlRequestJson).type;
		if (type === "retireAccount" || type === "retireRuntime")
			return '{"type":"retired"}';
		return type === "completeAccountRetirement"
			? '{"type":"retirementCompleted"}'
			: '{"type":"invariantViolation"}';
	},
});

const timerProbeRuntime = (
	bindings,
	downloadSink = unavailableDownloadSink(),
) =>
	bindings.WebClientRuntime.withConfiguredAttachmentMovePreparation(
		async () => '{"type":"deviceState","accounts":[]}',
		async () => '{"type":"done"}',
		async () => '{"type":"networkFailure"}',
		() => undefined,
		{ invoke: async () => ({ controlResponseJson: '{"type":"deviceWiped"}' }) },
		{
			invoke: async () => ({ controlResponseJson: '{"type":"deviceWiped"}' }),
			close: () => undefined,
		},
		{ acquire: async () => null },
		"timer-probe",
		"web",
		"1.0.0",
		() => undefined,
		downloadSink,
	);

test("authenticated WASM construction leaves callback-liveness probing to the trusted Worker host", async () => {
	const bindings = await import(
		pathToFileURL(resolve(combinedRoot, "index.js")).href
	);
	const wasm = await readFile(resolve(combinedRoot, "index_bg.wasm"));
	await bindings.default({ module_or_path: wasm });
	const originalSetTimeout = globalThis.setTimeout;
	try {
		globalThis.setTimeout = undefined;
		const missing = timerProbeRuntime(bindings);
		missing.free();
		globalThis.setTimeout = () => {
			throw new Error("timer rejected");
		};
		const throwing = timerProbeRuntime(bindings);
		throwing.free();
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
});

test("a missing or throwing WASM timer parks persistent sink cleanup after one attempt", async () => {
	const bindings = await import(
		pathToFileURL(resolve(combinedRoot, "index.js")).href
	);
	const wasm = await readFile(resolve(combinedRoot, "index_bg.wasm"));
	await bindings.default({ module_or_path: wasm });
	const originalSetTimeout = globalThis.setTimeout;
	for (const replacement of [
		undefined,
		() => {
			throw new Error("timer rejected");
		},
	]) {
		let attempts = 0;
		const runtime = timerProbeRuntime(bindings, {
			invoke: async (controlRequestJson) => {
				const type = JSON.parse(controlRequestJson).type;
				if (type === "retireRuntime") {
					attempts += 1;
					return '{"type":"sinkFailure"}';
				}
				return '{"type":"invariantViolation"}';
			},
		});
		try {
			globalThis.setTimeout = replacement;
			void runtime.request_json("wipe-without-timer", '{"type":"wipe"}');
			for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
			await delay(25);
			assert.equal(attempts, 1);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	}
});

test("one WebAssembly module exposes crypto and the Client Runtime", async () => {
	const productionWasm = (
		await Promise.all(
			[combinedRoot, standaloneRoot].map(async (root) => {
				try {
					return (await readdir(root))
						.filter((name) => name.endsWith("_bg.wasm"))
						.map((name) => resolve(root, name));
				} catch (error) {
					if (error?.code === "ENOENT") return [];
					throw error;
				}
			}),
		)
	).flat();
	const bindings = await import(
		pathToFileURL(resolve(combinedRoot, "index.js")).href
	);
	const wasm = await readFile(resolve(combinedRoot, "index_bg.wasm"));
	await bindings.default({ module_or_path: wasm });

	assert.equal(
		typeof bindings.ubrn_uniffi_bittery_crypto_api_checksum_func_generate_uuid,
		"function",
	);
	assert.equal(
		typeof bindings.ubrn_uniffi_bittery_crypto_api_fn_func_generate_uuid,
		"function",
	);
	assert.equal(typeof bindings.WebClientRuntime, "function");

	const runtime = new bindings.WebClientRuntime();
	const projections = [];
	runtime.observe_json(
		"runtime-status",
		JSON.stringify({ type: "runtimeStatus", accountId: null }),
		(value) => {
			projections.push(JSON.parse(value));
			runtime.unobserve("runtime-status");
		},
	);
	assert.deepEqual(projections, [
		{
			type: "runtimeStatus",
			// Revisions cross the boundary as canonical decimal strings, never as
			// JSON numbers, so a u64 past 2^53 survives the trip.
			value: { accountId: null, revision: "0", accounts: [], closed: false },
		},
	]);

	const responsePromise = runtime.request_json(
		"sign-in",
		JSON.stringify({
			type: "signIn",
			serverUrl: "https://server.test",
			email: "person@example.test",
			masterPassword: "UNIQUE_MASTER_PASSWORD",
			secretKey: "UNIQUE_SECRET_KEY",
			insecureTransportConfirmed: false,
		}),
	);
	assert.ok(responsePromise instanceof Promise);
	// The declared RuntimeOutcome envelope, not Serde's implicit `Result` spelling.
	assert.deepEqual(JSON.parse(await responsePromise), {
		type: "failed",
		value: {
			code: "AUTHENTICATION_UNAVAILABLE",
			message: "authentication is implemented by a later vertical slice",
		},
	});

	const closePromise = runtime.close();
	assert.ok(closePromise instanceof Promise);
	await closePromise;
	await runtime.close();
	runtime.free();

	const reentrantRuntime = new bindings.WebClientRuntime();
	let reentrantClose;
	reentrantRuntime.observe_json(
		"reentrant-close",
		JSON.stringify({ type: "runtimeStatus", accountId: null }),
		() => {
			reentrantClose = reentrantRuntime.close();
		},
	);
	assert.ok(reentrantClose instanceof Promise);
	await reentrantClose;
	await reentrantRuntime.close();
	reentrantRuntime.free();

	const replicaInvocations = [];
	const persistentRuntime = bindings.WebClientRuntime.withReplicaExecutor(
		async (requestJson) => {
			replicaInvocations.push(requestJson);
			throw new Error("not reached before Account rehydration");
		},
	);
	assert.ok(persistentRuntime instanceof bindings.WebClientRuntime);
	await persistentRuntime.close();
	persistentRuntime.free();
	assert.deepEqual(replicaInvocations, []);

	const platformInvocations = [];
	const openingRuntime = bindings.WebClientRuntime.withExecutors(
		async () => {
			throw new Error("Replica must stay cold while opening an empty catalog");
		},
		async (requestJson) => {
			platformInvocations.push(requestJson);
			return '{"type":"value","value":null}';
		},
		async () => '{"type":"networkFailure"}',
		() => undefined,
	);
	const openPromise = openingRuntime.open();
	assert.ok(openPromise instanceof Promise);
	await openPromise;
	assert.deepEqual(platformInvocations, [
		'{"type":"get","area":"devicePlain","key":"bittery:runtime:platform-storage:device-catalog"}',
	]);
	await openingRuntime.close();
	openingRuntime.free();

	const failingRuntime = bindings.WebClientRuntime.withExecutors(
		async () => "{}",
		async () => {
			throw new Error("PRIVATE_BROWSER_QUOTA_DETAIL");
		},
		async () => '{"type":"networkFailure"}',
		() => undefined,
	);
	await assert.rejects(failingRuntime.open(), (error) => {
		assert.match(String(error), /Platform storage invocation failed/);
		assert.doesNotMatch(String(error), /PRIVATE_BROWSER_QUOTA_DETAIL/);
		return true;
	});
	await failingRuntime.close();
	failingRuntime.free();

	assert.deepEqual(productionWasm, [resolve(combinedRoot, "index_bg.wasm")]);
});

test("artifact policy stays internal to the Rust Runtime", async () => {
	const bindings = await import(
		pathToFileURL(resolve(combinedRoot, "index.js")).href
	);
	const wasm = await readFile(resolve(combinedRoot, "index_bg.wasm"));
	await bindings.default({ module_or_path: wasm });
	assert.equal(bindings.WebAttachmentArtifactOwner, undefined);
	assert.equal(bindings.WebAttachmentArtifactStore, undefined);
});

test("the production module exposes no Attachment Move bridge test harness", async () => {
	if (process.env.BITTERY_BINDING_TEST_HARNESS === "1") return;
	const bindings = await import(
		pathToFileURL(resolve(combinedRoot, "index.js")).href
	);
	assert.equal(bindings.WebAttachmentMoveBridgeTestHarness, undefined);
});

test("the feature-only WASM harness exercises the closed lease and transfer bridge", {
	skip: process.env.BITTERY_BINDING_TEST_HARNESS !== "1",
}, async () => {
	const bindings = await import(
		pathToFileURL(resolve(combinedRoot, "index.js")).href
	);
	const wasm = await readFile(resolve(combinedRoot, "index_bg.wasm"));
	await bindings.default({ module_or_path: wasm });

	assert.equal(typeof bindings.WebAttachmentMoveBridgeTestHarness, "function");

	const transferRequests = [];
	let pendingTransfer;
	const binaryExecutor = {
		invoke(requestJson) {
			assert.equal(this, binaryExecutor);
			const request = JSON.parse(requestJson);
			transferRequests.push(request);
			if (request.type === "openDownload" && pendingTransfer) {
				return pendingTransfer.promise;
			}
			const response =
				request.type === "openDownload"
					? { type: "downloadOpened" }
					: request.type === "beginUpload"
						? { type: "uploadBegun" }
						: { type: "cancelled" };
			return Promise.resolve({
				controlResponseJson: JSON.stringify(response),
			});
		},
		close() {
			assert.equal(this, binaryExecutor);
		},
	};
	let nextLease = null;
	const acquiredAccounts = [];
	const leaseExecutor = {
		acquire(accountId) {
			assert.equal(this, leaseExecutor);
			acquiredAccounts.push(accountId);
			return Promise.resolve(nextLease);
		},
	};
	const harness = new bindings.WebAttachmentMoveBridgeTestHarness(
		binaryExecutor,
		leaseExecutor,
	);

	harness.reset_lifecycle_drop_probe();
	let configuredBinaryCloses = 0;
	const configuredBinary = {
		invoke: async () => {
			throw new Error("no transfer is reachable before open");
		},
		close() {
			assert.equal(this, configuredBinary);
			configuredBinaryCloses += 1;
		},
	};
	let configuredLifecycleError;
	const configured =
		bindings.WebClientRuntime.withConfiguredAttachmentMovePreparation(
			async () => {
				throw new Error("Replica stays cold before open");
			},
			async () => {
				throw new Error("Platform storage stays cold before open");
			},
			async () => '{"type":"networkFailure"}',
			() => undefined,
			{
				invoke: async () => {
					throw new Error("Artifacts stay cold before open");
				},
			},
			configuredBinary,
			{ acquire: async () => null },
			"client-test",
			"web",
			"1.0.0",
			(json) => {
				configuredLifecycleError = json;
			},
			unavailableDownloadSink(),
		);
	assert.equal(harness.lifecycle_drop_probe(), 0);
	configured.free();
	assert.equal(harness.lifecycle_drop_probe(), 1);
	assert.equal(configuredBinaryCloses, 1);
	assert.equal(configuredLifecycleError, undefined);

	harness.reset_lifecycle_drop_probe();
	let reentrantPolls = 0;
	const reentrantHarness = new bindings.WebAttachmentMoveBridgeTestHarness(
		{
			invoke: async () => {
				throw new Error("no transfer is reachable");
			},
			close: () => undefined,
		},
		{ acquire: async () => null },
	);
	reentrantHarness.start_reentrant_lifecycle(() => {
		reentrantPolls += 1;
		reentrantHarness.free();
	});
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(reentrantPolls, 1);
	assert.equal(harness.lifecycle_drop_probe(), 1);

	assert.equal(await harness.acquire_lease("account-denied"), false);
	assert.deepEqual(acquiredAccounts, ["account-denied"]);

	let resolveLost;
	let releases = 0;
	const liveHandle = {
		isLive() {
			assert.equal(this, liveHandle);
			return true;
		},
		lost() {
			assert.equal(this, liveHandle);
			return new Promise((resolve) => {
				resolveLost = resolve;
			});
		},
		release() {
			assert.equal(this, liveHandle);
			releases += 1;
		},
	};
	nextLease = liveHandle;
	assert.equal(await harness.acquire_lease("account-live"), true);
	assert.equal(harness.lease_is_live(), true);
	const lossObserved = new Promise((resolve) =>
		harness.wait_for_lease_loss(resolve),
	);
	await Promise.resolve();
	resolveLost();
	await lossObserved;
	assert.equal(releases, 1);

	for (const extra of ["symbol", "non-enumerable"]) {
		let invalidReleases = 0;
		const invalid = {
			isLive() {
				return true;
			},
			lost() {
				return Promise.resolve();
			},
			release() {
				invalidReleases += 1;
			},
		};
		if (extra === "symbol") invalid[Symbol("policy")] = "forbidden";
		else
			Object.defineProperty(invalid, "operationId", {
				value: "forbidden",
			});
		nextLease = invalid;
		await assert.rejects(harness.acquire_lease(`account-${extra}`));
		assert.equal(invalidReleases, 1);
	}

	let overflowReleases = 0;
	const overflowHandle = {
		isLive: () => true,
		lost: () => Promise.resolve(),
		release: () => {
			overflowReleases += 1;
		},
	};
	harness.exhaust_lease_identity();
	nextLease = overflowHandle;
	await assert.rejects(harness.acquire_lease("account-overflow"));
	assert.equal(overflowReleases, 1);

	let lateResolve;
	let lateReleases = 0;
	const lateHandle = {
		isLive: () => true,
		lost: () => Promise.resolve(),
		release: () => {
			lateReleases += 1;
		},
	};
	const pendingLeaseExecutor = {
		acquire(accountId) {
			assert.equal(this, pendingLeaseExecutor);
			assert.equal(accountId, "account-late");
			return new Promise((resolve) => {
				lateResolve = resolve;
			});
		},
	};
	const closingHarness = new bindings.WebAttachmentMoveBridgeTestHarness(
		binaryExecutor,
		pendingLeaseExecutor,
	);
	const lateAcquire = closingHarness.acquire_lease("account-late");
	await Promise.resolve();
	closingHarness.close();
	lateResolve(lateHandle);
	await assert.rejects(lateAcquire);
	assert.equal(lateReleases, 1);

	await harness.open_download("https://objects.test/source?opaque=credential");
	const opened = transferRequests.at(-1);
	assert.equal(opened.type, "openDownload");
	assert.equal(opened.url, "https://objects.test/source?opaque=credential");
	assert.deepEqual(opened.headers, [{ name: "x-signed", value: "opaque" }]);
	assert.equal(opened.storageKey, undefined);
	harness.drop_download();
	await Promise.resolve();
	const droppedCancel = transferRequests.at(-1);
	assert.equal(droppedCancel.type, "cancelTransfer");

	const serverStorageKey = "SENTINEL_SERVER_STORAGE_KEY";
	await harness.open_upload(serverStorageKey);
	const uploadOpened = transferRequests.at(-1);
	assert.equal(uploadOpened.type, "beginUpload");
	assert.equal(uploadOpened.accountId, "account-upload");
	assert.equal(uploadOpened.operationId, "operation-upload");
	assert.equal(uploadOpened.attachmentId, "attachment-upload");
	assert.match(uploadOpened.artifactId, /^[0-9a-f]{64}$/);
	assert.equal(
		uploadOpened.url,
		"https://objects.test/upload?opaque=credential",
	);
	assert.equal(uploadOpened.byteLength, "1");
	assert.match(uploadOpened.ciphertextSha256, /^[0-9a-f]{64}$/);
	assert.deepEqual(uploadOpened.headers, [
		{ name: "content-type", value: "application/octet-stream" },
		{
			name: "x-amz-content-sha256",
			value: uploadOpened.ciphertextSha256,
		},
	]);
	assert.equal(uploadOpened.storageKey, undefined);
	assert.notEqual(uploadOpened.generation, serverStorageKey);
	assert.equal(uploadOpened.generation, uploadOpened.transferId);
	assert.notEqual(uploadOpened.transferId, opened.transferId);
	assert.match(uploadOpened.generation, /^[0-9a-f]{32}-[0-9a-f]{16}$/);
	harness.drop_upload();
	await Promise.resolve();
	assert.equal(transferRequests.at(-1).type, "cancelTransfer");

	let pendingCallback;
	pendingTransfer = {};
	pendingTransfer.promise = new Promise(() => {});
	const abandoned = new Promise((resolve) => {
		pendingCallback = resolve;
	});
	harness.start_pending_download(
		"https://objects.test/pending?opaque=credential",
		pendingCallback,
	);
	await Promise.resolve();
	const pendingOpened = transferRequests.at(-1);
	assert.equal(pendingOpened.type, "openDownload");
	assert.notEqual(pendingOpened.transferId, opened.transferId);
	assert.equal(pendingOpened.storageKey, undefined);
	harness.close();
	assert.equal(await abandoned, "abandoned");
	await Promise.resolve();
	assert.equal(transferRequests.at(-1).type, "cancelTransfer");

	let observedLifecycle;
	harness.observe_lifecycle_error((json) => {
		observedLifecycle = JSON.parse(json);
	});
	assert.deepEqual(observedLifecycle, {
		code: "INVARIANT_VIOLATION",
		message: "Attachment Move preparation lifecycle failed",
	});

	const symbolExecutor = {
		acquire: async () => null,
		[Symbol("policy")]: true,
	};
	assert.throws(
		() =>
			new bindings.WebAttachmentMoveBridgeTestHarness(
				binaryExecutor,
				symbolExecutor,
			),
	);
	harness.free();
	closingHarness.free();
});

test("Web teardown destroys the ciphertext spool and converges", async () => {
	const bindings = await import(
		pathToFileURL(resolve(combinedRoot, "index.js")).href
	);
	const wasm = await readFile(resolve(combinedRoot, "index_bg.wasm"));
	await bindings.default({ module_or_path: wasm });

	const composed = (spoolResponse) => {
		const spoolRequests = [];
		const artifactRequests = [];
		const replicaRequests = [];
		const platformRequests = [];
		const runtime =
			bindings.WebClientRuntime.withConfiguredAttachmentMovePreparation(
				async (requestJson) => {
					const request = JSON.parse(requestJson);
					replicaRequests.push(request);
					if (request.type === "deleteAccount")
						return '{"type":"accountDeleted"}';
					if (request.type === "wipeDevice") return '{"type":"deviceWiped"}';
					throw new Error(`unexpected Replica request ${request.type}`);
				},
				async (requestJson) => {
					const request = JSON.parse(requestJson);
					platformRequests.push(request);
					return request.type === "get"
						? '{"type":"value","value":null}'
						: '{"type":"done"}';
				},
				async () => '{"type":"networkFailure"}',
				() => undefined,
				{
					invoke: async (requestJson) => {
						const request = JSON.parse(requestJson);
						artifactRequests.push(request);
						return {
							controlResponseJson: JSON.stringify(
								request.type === "wipeDevice"
									? { type: "deviceWiped" }
									: { type: "accountDeleted" },
							),
						};
					},
				},
				{
					invoke: async (requestJson) => {
						const request = JSON.parse(requestJson);
						spoolRequests.push(request);
						return {
							controlResponseJson: JSON.stringify(spoolResponse(request)),
						};
					},
					close: () => undefined,
				},
				{ acquire: async () => null },
				"client-teardown",
				"web",
				"1.0.0",
				() => undefined,
				unavailableDownloadSink(),
			);
		return {
			runtime,
			spoolRequests,
			artifactRequests,
			replicaRequests,
			platformRequests,
		};
	};

	const honest = (request) =>
		request.type === "wipeDevice"
			? { type: "deviceWiped" }
			: { type: "accountDeleted" };

	const removal = composed(honest);
	await removal.runtime.open();
	assert.deepEqual(
		JSON.parse(
			await removal.runtime.request_json(
				"remove",
				'{"type":"removeAccount","accountId":"account-teardown"}',
			),
		),
		{
			type: "succeeded",
			value: {
				type: "teardown",
				scope: { type: "account", accountId: "account-teardown" },
				status: "complete",
			},
		},
	);
	assert.deepEqual(removal.spoolRequests, [
		{ type: "deleteAccount", accountId: "account-teardown" },
	]);
	await removal.runtime.close();
	removal.runtime.free();

	const wipe = composed(honest);
	await wipe.runtime.open();
	assert.deepEqual(
		JSON.parse(await wipe.runtime.request_json("wipe", '{"type":"wipe"}')),
		{
			type: "succeeded",
			value: {
				type: "teardown",
				scope: { type: "device" },
				status: "complete",
			},
		},
	);
	assert.deepEqual(wipe.spoolRequests, [{ type: "wipeDevice" }]);
	await wipe.runtime.close();
	wipe.runtime.free();

	// A right-shaped answer for the wrong scope is a failure, not convergence.
	const crossed = composed(() => ({ type: "deviceWiped" }));
	await crossed.runtime.open();
	assert.deepEqual(
		JSON.parse(
			await crossed.runtime.request_json(
				"remove",
				'{"type":"removeAccount","accountId":"account-teardown"}',
			),
		),
		{
			type: "succeeded",
			value: {
				type: "teardown",
				scope: { type: "account", accountId: "account-teardown" },
				status: "incomplete",
				failures: ["hostCleanup"],
			},
		},
	);
	await crossed.runtime.close();
	crossed.runtime.free();
});

test("an observation admitted while a Wipe waits is caught up before it is resumed", async () => {
	const bindings = await import(
		pathToFileURL(resolve(combinedRoot, "index.js")).href
	);
	const wasm = await readFile(resolve(combinedRoot, "index_bg.wasm"));
	await bindings.default({ module_or_path: wasm });

	// The Wipe waits behind a Sign-in that holds the teardown admission lock across its
	// transport call. That wait is the one window where an observation is admitted after the
	// Wipe suspended every live sink and before the Runtime fences new observations.
	let releaseTransport;
	let markTransportEntered;
	const transportReleased = new Promise((resolve) => {
		releaseTransport = resolve;
	});
	const transportEntered = new Promise((resolve) => {
		markTransportEntered = resolve;
	});
	const runtime = bindings.WebClientRuntime.withConfiguredExecutors(
		async (requestJson) =>
			JSON.parse(requestJson).type === "wipeDevice"
				? '{"type":"deviceWiped"}'
				: '{"type":"accountDeleted"}',
		async (requestJson) =>
			JSON.parse(requestJson).type === "get"
				? '{"type":"value","value":null}'
				: '{"type":"done"}',
		async () => {
			markTransportEntered();
			await transportReleased;
			return '{"type":"networkFailure"}';
		},
		() => undefined,
		"client-balance",
		"web",
		"1.0.0",
	);
	await runtime.open();

	const signingIn = runtime.request_json(
		"sign-in",
		JSON.stringify({
			type: "signIn",
			serverUrl: "https://server.test",
			email: "person@example.test",
			masterPassword: "UNIQUE_MASTER_PASSWORD",
			secretKey: "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2",
			insecureTransportConfirmed: false,
		}),
	);
	await transportEntered;
	const wiping = runtime.request_json("wipe", '{"type":"wipe"}');
	await Promise.resolve();

	const projections = [];
	runtime.observe_json(
		"admitted-mid-wipe",
		JSON.stringify({ type: "runtimeStatus", accountId: null }),
		(json) => projections.push(JSON.parse(json)),
	);
	// The Wipe already suspended every live sink, so this one must stay silent too.
	assert.deepEqual(projections, []);

	releaseTransport();
	assert.equal(JSON.parse(await signingIn).type, "failed");
	// Resuming a sink that was never suspended traps the WebAssembly module. Reaching this
	// answer at all is the proof that suspend, catch-up, and resume stayed balanced.
	const wiped = JSON.parse(await wiping);
	assert.equal(wiped.type, "succeeded");
	assert.equal(wiped.value.type, "teardown");
	assert.deepEqual(wiped.value.scope, { type: "device" });

	runtime.unobserve("admitted-mid-wipe");
	await runtime.close();
	runtime.free();
});

// One composition for the two host-cleanup failure tests. Every seam but the ciphertext spool
// answers honestly, so whatever the teardown reports is the spool's doing and nothing else's.
const teardownRuntime = (bindings, spoolInvoke) => {
	const spoolRequests = [];
	const runtime =
		bindings.WebClientRuntime.withConfiguredAttachmentMovePreparation(
			async (requestJson) => {
				const request = JSON.parse(requestJson);
				if (request.type === "deleteAccount")
					return '{"type":"accountDeleted"}';
				if (request.type === "wipeDevice") return '{"type":"deviceWiped"}';
				throw new Error(`unexpected Replica request ${request.type}`);
			},
			async (requestJson) =>
				JSON.parse(requestJson).type === "get"
					? '{"type":"value","value":null}'
					: '{"type":"done"}',
			async () => '{"type":"networkFailure"}',
			() => undefined,
			{
				invoke: async (requestJson) => ({
					controlResponseJson: JSON.stringify(
						JSON.parse(requestJson).type === "wipeDevice"
							? { type: "deviceWiped" }
							: { type: "accountDeleted" },
					),
				}),
			},
			{
				invoke: async (requestJson) => {
					const request = JSON.parse(requestJson);
					spoolRequests.push(request);
					return spoolInvoke(request, spoolRequests.length);
				},
				close: () => undefined,
			},
			{ acquire: async () => null },
			"client-teardown",
			"web",
			"1.0.0",
			() => undefined,
			unavailableDownloadSink(),
		);
	return { runtime, spoolRequests };
};

test("a spool answer that smuggles side-channel bytes cannot converge a teardown", async () => {
	const bindings = await import(
		pathToFileURL(resolve(combinedRoot, "index.js")).href
	);
	const wasm = await readFile(resolve(combinedRoot, "index_bg.wasm"));
	await bindings.default({ module_or_path: wasm });

	// The scope is the one that was asked for, but destruction has no side channel. A host that
	// returns bytes anyway is not answering the question this phase asked.
	const { runtime, spoolRequests } = teardownRuntime(bindings, (request) => ({
		controlResponseJson: JSON.stringify(
			request.type === "wipeDevice"
				? { type: "deviceWiped" }
				: { type: "accountDeleted" },
		),
		bytes: new ArrayBuffer(8),
	}));
	await runtime.open();

	assert.deepEqual(
		JSON.parse(
			await runtime.request_json(
				"remove",
				'{"type":"removeAccount","accountId":"account-teardown"}',
			),
		),
		{
			type: "succeeded",
			value: {
				type: "teardown",
				scope: { type: "account", accountId: "account-teardown" },
				status: "incomplete",
				failures: ["hostCleanup"],
			},
		},
	);
	assert.deepEqual(spoolRequests, [
		{ type: "deleteAccount", accountId: "account-teardown" },
	]);

	await runtime.close();
	runtime.free();
});

test("a throwing spool executor reports host cleanup and an identical retry converges", async () => {
	const bindings = await import(
		pathToFileURL(resolve(combinedRoot, "index.js")).href
	);
	const wasm = await readFile(resolve(combinedRoot, "index_bg.wasm"));
	await bindings.default({ module_or_path: wasm });

	// This joins the two halves the earlier tests prove apart: the TypeScript executor throws an
	// opaque invocation error, and Core turns a failed host-cleanup call into the named phase.
	const { runtime, spoolRequests } = teardownRuntime(
		bindings,
		(request, attempt) => {
			if (attempt === 1) throw new Error("OPFS_QUOTA_DETAIL");
			return {
				controlResponseJson: JSON.stringify(
					request.type === "wipeDevice"
						? { type: "deviceWiped" }
						: { type: "accountDeleted" },
				),
			};
		},
	);
	await runtime.open();

	assert.deepEqual(
		JSON.parse(await runtime.request_json("wipe-1", '{"type":"wipe"}')),
		{
			type: "succeeded",
			value: {
				type: "teardown",
				scope: { type: "device" },
				status: "incomplete",
				failures: ["hostCleanup"],
			},
		},
	);

	assert.deepEqual(
		JSON.parse(await runtime.request_json("wipe-2", '{"type":"wipe"}')),
		{
			type: "succeeded",
			value: {
				type: "teardown",
				scope: { type: "device" },
				status: "complete",
			},
		},
	);
	assert.deepEqual(spoolRequests, [
		{ type: "wipeDevice" },
		{ type: "wipeDevice" },
	]);

	await runtime.close();
	runtime.free();
});
