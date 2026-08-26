import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const combinedRoot =
	process.env.BITTERY_COMBINED_WEB_BINDINGS_ROOT ??
	resolve(scriptRoot, "../../crypto/wasm/generated/wasm-bindgen");
const standaloneRoot = resolve(scriptRoot, "../generated/web");

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

test(
	"the feature-only WASM harness exercises the closed lease and transfer bridge",
	{ skip: process.env.BITTERY_BINDING_TEST_HARNESS !== "1" },
	async () => {
		const bindings = await import(
			pathToFileURL(resolve(combinedRoot, "index.js")).href
		);
		const wasm = await readFile(resolve(combinedRoot, "index_bg.wasm"));
		await bindings.default({ module_or_path: wasm });

		assert.equal(
			typeof bindings.WebAttachmentMoveBridgeTestHarness,
			"function",
		);

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

		await harness.open_download(
			"https://objects.test/source?opaque=credential",
		);
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
	},
);
