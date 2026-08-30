import type { Page, Route } from "@playwright/test";
import { nanoid } from "nanoid";
import { expect, generateTestUser, signUp, test } from "../fixtures/auth";
import { activateTeamPlan } from "../fixtures/billing";
import { runE2eSql, sqlString } from "../fixtures/e2e-database";
import {
	createItem,
	VAULT_READY_TIMEOUT_MS,
	vaultNavLink,
} from "../fixtures/vault";

const TEST_BUDGET_MS = 420_000;
const PREPARATION_FAILURES = 6;
const ARTIFACT_DATABASE = "bittery_attachment_artifacts";
const ARTIFACT_STORES = [
	"chunks",
	"provisional_chunks",
	"artifacts",
	"provisional_artifacts",
] as const;
const ORPHAN_ARTIFACT_ID = "00000000-0000-4000-8000-000000000281";
const ORPHAN_OPERATION_ID = "00000000-0000-4000-8000-000000000282";
const ORPHAN_ATTACHMENT_ID = "00000000-0000-4000-8000-000000000283";
const ORPHAN_GENERATION = "00000000-0000-4000-8000-000000000284";
const ORPHAN_CHUNK_SHA256 =
	"6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d";

type StoredRow = {
	accountId: string;
	recordId: string;
	payloadJson: string;
};

type PreparationRequestCounters = {
	manifestCalls: number;
	manifestFailures: number;
	downloadAttempts: number;
	stagingUploads: number;
	moveDispatches: number;
};

type ResumedSweepPhase =
	| "before-restart"
	| "restart-before-unlock-arm"
	| "awaiting-first-manifest"
	| "first-manifest-held"
	| "downstream-open";

async function replicaRows(
	page: Page,
	storeName: string,
): Promise<StoredRow[]> {
	return page.evaluate(async (store) => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("bittery_replica");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			return await new Promise<StoredRow[]>((resolve, reject) => {
				const request = database
					.transaction(store, "readonly")
					.objectStore(store)
					.getAll();
				request.onsuccess = () => resolve(request.result as StoredRow[]);
				request.onerror = () => reject(request.error);
			});
		} finally {
			database.close();
		}
	}, storeName);
}

async function artifactRows(page: Page, accountId: string): Promise<number[]> {
	return page.evaluate(
		async ({ accountId, databaseName, storeNames }) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(databaseName);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction(storeNames, "readonly");
				return await Promise.all(
					storeNames.map(
						(storeName) =>
							new Promise<number>((resolve, reject) => {
								const request = transaction
									.objectStore(storeName)
									.index("by_account")
									.count(IDBKeyRange.only(accountId));
								request.onsuccess = () => resolve(request.result);
								request.onerror = () => reject(request.error);
							}),
					),
				);
			} finally {
				database.close();
			}
		},
		{
			accountId,
			databaseName: ARTIFACT_DATABASE,
			storeNames: ARTIFACT_STORES,
		},
	);
}

async function orphanArtifactRows(
	page: Page,
	accountId: string,
): Promise<number[]> {
	return page.evaluate(
		async ({ accountId, databaseName, storeNames, orphan }) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(databaseName);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction(storeNames, "readonly");
				const keys: readonly IDBValidKey[] = [
					[accountId, orphan.artifactId, 0],
					[
						accountId,
						orphan.operationId,
						orphan.attachmentId,
						orphan.generation,
						0,
					],
					[accountId, orphan.artifactId],
					[
						accountId,
						orphan.operationId,
						orphan.attachmentId,
						orphan.generation,
					],
				];
				return await Promise.all(
					storeNames.map(
						(storeName, index) =>
							new Promise<number>((resolve, reject) => {
								const request = transaction
									.objectStore(storeName)
									.count(keys[index]);
								request.onsuccess = () => resolve(request.result);
								request.onerror = () => reject(request.error);
							}),
					),
				);
			} finally {
				database.close();
			}
		},
		{
			accountId,
			databaseName: ARTIFACT_DATABASE,
			storeNames: ARTIFACT_STORES,
			orphan: {
				artifactId: ORPHAN_ARTIFACT_ID,
				operationId: ORPHAN_OPERATION_ID,
				attachmentId: ORPHAN_ATTACHMENT_ID,
				generation: ORPHAN_GENERATION,
			},
		},
	);
}

async function seedOrphanArtifact(
	page: Page,
	accountId: string,
): Promise<void> {
	await page.evaluate(
		async ({ accountId, databaseName, storeNames, orphan }) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(databaseName);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction(storeNames, "readwrite");
				transaction.objectStore("artifacts").add({
					accountId,
					operationId: orphan.operationId,
					attachmentId: orphan.attachmentId,
					artifactId: orphan.artifactId,
					ciphertextSha256: orphan.chunkSha256,
					byteLength: "1",
					chunkCount: 1,
					publicationState: "published",
					durableChunkCount: 1,
				});
				transaction.objectStore("chunks").add({
					accountId,
					artifactId: orphan.artifactId,
					chunkIndex: 0,
					chunkSha256: orphan.chunkSha256,
					bytes: new Uint8Array([0]).buffer,
				});
				transaction.objectStore("provisional_artifacts").add({
					accountId,
					operationId: orphan.operationId,
					attachmentId: orphan.attachmentId,
					generation: orphan.generation,
					current: true,
					publicationState: 0,
					durableChunkCount: 1,
					durableByteLength: 1,
					minimumChunkIndex: 0,
					maximumChunkIndex: 0,
				});
				transaction.objectStore("provisional_chunks").add({
					accountId,
					operationId: orphan.operationId,
					attachmentId: orphan.attachmentId,
					generation: orphan.generation,
					chunkIndex: 0,
					chunkSha256: orphan.chunkSha256,
					bytes: new Uint8Array([0]).buffer,
				});
				await new Promise<void>((resolve, reject) => {
					transaction.oncomplete = () => resolve();
					transaction.onerror = () => reject(transaction.error);
					transaction.onabort = () => reject(transaction.error);
				});
			} finally {
				database.close();
			}
		},
		{
			accountId,
			databaseName: ARTIFACT_DATABASE,
			storeNames: ARTIFACT_STORES,
			orphan: {
				artifactId: ORPHAN_ARTIFACT_ID,
				operationId: ORPHAN_OPERATION_ID,
				attachmentId: ORPHAN_ATTACHMENT_ID,
				generation: ORPHAN_GENERATION,
				chunkSha256: ORPHAN_CHUNK_SHA256,
			},
		},
	);
}

function isObjectStorage(route: Route): boolean {
	return new URL(route.request().url()).port === "3030";
}

async function openRuntimeVault(page: Page, vaultId: string): Promise<void> {
	await page.getByRole("link", { name: "Vaults", exact: true }).first().click();
	await page.waitForURL("**/vaults");
	await expect(vaultNavLink(page, vaultId)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await vaultNavLink(page, vaultId).click();
	await page.waitForURL(`**/vaults/${vaultId}`);
	await expect(page.getByTestId("new-item-button")).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
}

test("authenticated real Core resumes durable Attachment Move preparation after restart", async ({
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);
	const context = await browser.newContext();
	const page = await context.newPage();
	const suffix = nanoid(6);
	let preparationActive = false;
	let downloadAttempts = 0;
	let stagingUploads = 0;
	let manifestCalls = 0;
	let manifestFailures = 0;
	let resumedManifestInspectionArmed = false;
	let firstResumedManifestInspection: Promise<number[]> | undefined;
	let moveDispatches = 0;
	let promotedOperationRows: StoredRow[] | undefined;
	let promotedPreparationRows: StoredRow[] | undefined;
	let releaseStagingUpload: (() => void) | undefined;
	let stagingUploadReleased = false;
	const stagingUploadHeld = new Promise<void>((resolve) => {
		releaseStagingUpload = resolve;
	});
	let releaseMoveDispatch: (() => void) | undefined;
	let moveDispatchReleased = false;
	const moveDispatchHeld = new Promise<void>((resolve) => {
		releaseMoveDispatch = resolve;
	});
	let releaseResumedManifest: (() => void) | undefined;
	const resumedManifestHeld = new Promise<void>((resolve) => {
		releaseResumedManifest = resolve;
	});
	let releaseRejectedPreparationRoutes: (() => void) | undefined;
	const rejectedPreparationRoutesHeld = new Promise<void>((resolve) => {
		releaseRejectedPreparationRoutes = resolve;
	});
	let resumedSweepPhase: ResumedSweepPhase = "before-restart";
	let resumedManifestReleased = false;
	let expectedResumedManifestPath: string | undefined;
	let restartBaseline: PreparationRequestCounters | undefined;
	const requestsBeforeUnlockArm: string[] = [];
	const objectRequestsBeforeBarrierRelease: string[] = [];
	const concurrentResumedManifests: string[] = [];
	const unexpectedResumedManifests: string[] = [];
	const resumedManifestBarrierEntries: string[] = [];
	const guardedPreparationBypasses: string[] = [];

	await context.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const requestDescription = `${request.method()} ${url.pathname}`;
		const isManifestPut =
			request.method() === "PUT" &&
			/^\/api\/v1\/operations\/[0-9a-f-]{36}\/attachment-move-manifest$/.test(
				url.pathname,
			);
		const isSourceObjectGet =
			preparationActive && isObjectStorage(route) && request.method() === "GET";
		const isStagingObjectPut =
			preparationActive &&
			isObjectStorage(route) &&
			request.method() === "PUT" &&
			url.pathname.includes("/attachments/staging/");
		if (isManifestPut) {
			manifestCalls += 1;
			if (
				preparationActive &&
				resumedSweepPhase === "before-restart" &&
				manifestFailures < PREPARATION_FAILURES
			) {
				manifestFailures += 1;
				await route.abort("connectionreset");
				return;
			}
			if (resumedSweepPhase === "restart-before-unlock-arm") {
				requestsBeforeUnlockArm.push(requestDescription);
				await rejectedPreparationRoutesHeld;
				await route.abort("blockedbyclient");
				return;
			}
			if (
				resumedSweepPhase === "awaiting-first-manifest" &&
				url.pathname === expectedResumedManifestPath &&
				resumedManifestInspectionArmed &&
				firstResumedManifestInspection === undefined
			) {
				resumedSweepPhase = "first-manifest-held";
				resumedManifestBarrierEntries.push(requestDescription);
				firstResumedManifestInspection = (async () => {
					const accountId = await page.evaluate(() =>
						localStorage.getItem("bittery_runtime_account_id"),
					);
					if (!accountId)
						throw new Error("Runtime Account identity disappeared.");
					return orphanArtifactRows(page, accountId);
				})();
				await firstResumedManifestInspection;
				await resumedManifestHeld;
				if (!resumedManifestReleased) {
					await route.abort("blockedbyclient");
					return;
				}
				await route.continue();
				return;
			}
			if (
				resumedSweepPhase === "awaiting-first-manifest" ||
				resumedSweepPhase === "first-manifest-held"
			) {
				if (url.pathname === expectedResumedManifestPath) {
					concurrentResumedManifests.push(requestDescription);
				} else {
					unexpectedResumedManifests.push(requestDescription);
				}
				await rejectedPreparationRoutesHeld;
				await route.abort("blockedbyclient");
				return;
			}
			if (
				resumedSweepPhase !== "before-restart" &&
				resumedSweepPhase !== "downstream-open"
			) {
				guardedPreparationBypasses.push(requestDescription);
				await rejectedPreparationRoutesHeld;
				await route.abort("blockedbyclient");
				return;
			}
			await route.continue();
			return;
		}
		if (
			preparationActive &&
			request.method() === "POST" &&
			/^\/api\/v1\/items\/[0-9a-f-]{36}\/moves$/.test(url.pathname)
		) {
			moveDispatches += 1;
			if (resumedSweepPhase === "restart-before-unlock-arm") {
				requestsBeforeUnlockArm.push(requestDescription);
				await rejectedPreparationRoutesHeld;
				await route.abort("blockedbyclient");
				return;
			}
			if (
				resumedSweepPhase === "awaiting-first-manifest" ||
				resumedSweepPhase === "first-manifest-held"
			) {
				guardedPreparationBypasses.push(requestDescription);
				await rejectedPreparationRoutesHeld;
				await route.abort("blockedbyclient");
				return;
			}
			[promotedOperationRows, promotedPreparationRows] = await Promise.all([
				replicaRows(page, "operations"),
				replicaRows(page, "attachment_move_preparations"),
			]);
			await moveDispatchHeld;
			if (!moveDispatchReleased) {
				await route.abort("blockedbyclient");
				return;
			}
			await route.continue();
			return;
		}
		if (!isSourceObjectGet && !isStagingObjectPut) {
			await route.continue();
			return;
		}
		if (resumedSweepPhase === "restart-before-unlock-arm") {
			requestsBeforeUnlockArm.push(requestDescription);
			await rejectedPreparationRoutesHeld;
			await route.abort("blockedbyclient");
			return;
		}
		if (
			resumedSweepPhase === "awaiting-first-manifest" ||
			resumedSweepPhase === "first-manifest-held"
		) {
			objectRequestsBeforeBarrierRelease.push(requestDescription);
			await rejectedPreparationRoutesHeld;
			await route.abort("blockedbyclient");
			return;
		}
		if (
			resumedSweepPhase !== "before-restart" &&
			resumedSweepPhase !== "downstream-open"
		) {
			guardedPreparationBypasses.push(requestDescription);
			await rejectedPreparationRoutesHeld;
			await route.abort("blockedbyclient");
			return;
		}
		if (isSourceObjectGet) {
			downloadAttempts += 1;
			await route.continue();
			return;
		}
		if (isStagingObjectPut) {
			stagingUploads += 1;
			await stagingUploadHeld;
			if (!stagingUploadReleased) {
				await route.abort("blockedbyclient");
				return;
			}
			await route.continue();
			return;
		}
		await route.continue();
	});

	try {
		// Ticket 30 owns the held SSE lifetime. A finite wakeup keeps this acceptance
		// on the authenticated production transport without widening that frontier.
		await page.route("**/api/v1/sync/events", (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: "event: ping\ndata: {}\n\n",
			}),
		);
		let targetVaultId: string | undefined;
		const user = await signUp(page, generateTestUser(), {
			beforeRuntimeSignIn: async (legacyPage) => {
				targetVaultId = await legacyPage.evaluate(async (name) => {
					const storageModulePath = "/src/lib/storage.ts";
					const cryptoModulePath = "/src/lib/crypto.ts";
					const vaultRuntimeModulePath = "/src/lib/vault-runtime.ts";
					const vaultServiceModulePath =
						"/@id/@bittery/core/services/vault-service";
					const accountResolverModulePath =
						"/@id/@bittery/core/services/account-resolver";
					const [
						{ storage },
						{ crypto },
						{ vaultCrypto },
						vaultServiceModule,
						accountResolverModule,
					] = await Promise.all([
						import(storageModulePath),
						import(cryptoModulePath),
						import(vaultRuntimeModulePath),
						import(vaultServiceModulePath),
						import(accountResolverModulePath),
					]);
					const accountId = await storage.getActiveAccount();
					if (!accountId)
						throw new Error("Legacy signup did not install its Account.");
					const service = new vaultServiceModule.VaultService({
						storage,
						crypto,
						vaultCrypto,
						accounts: new accountResolverModule.AccountResolver(storage),
						vaultKeyProjection: { async syncVaultKeys() {} },
					});
					return (
						await service.createVault({
							name,
							type: "personal",
							icon: "lock",
							accountId,
						})
					).vaultId;
				}, `Move target ${suffix}`);
			},
		});
		if (!targetVaultId)
			throw new Error("Pre-Runtime fixture did not create the target Vault.");
		const moveTargetVaultId = targetVaultId;
		activateTeamPlan(user.email);
		const sourceVaultResult = runE2eSql(`
			SELECT coalesce(json_agg(source.id ORDER BY source.id), '[]'::json)::text
			FROM (
				SELECT vault.id
				FROM vault
				JOIN "user" ON "user".id = vault.created_by_id
				WHERE "user".email = '${sqlString(user.email)}'
				  AND vault.type = 'personal'
				  AND vault.id <> '${sqlString(moveTargetVaultId)}'
			) source;
		`);
		const sourceVaultIds = JSON.parse(
			sourceVaultResult.match(/\[[^\n]*\]/)?.[0] ?? "[]",
		) as unknown;
		if (
			!Array.isArray(sourceVaultIds) ||
			sourceVaultIds.length !== 1 ||
			typeof sourceVaultIds[0] !== "string" ||
			!/^[0-9a-f-]{36}$/.test(sourceVaultIds[0]) ||
			sourceVaultIds[0] === moveTargetVaultId
		) {
			throw new Error(
				`Expected exactly one distinct personal source Vault, received ${JSON.stringify(sourceVaultIds)}.`,
			);
		}
		const sourceVaultId = sourceVaultIds[0];

		await openRuntimeVault(page, sourceVaultId);
		const itemId = await createItem(page, "login", async (sheet) => {
			await sheet.locator("#title").fill(`Attachment Move ${suffix}`);
			await sheet.locator("#username").fill(`move-${suffix}`);
			await sheet.locator("#password").fill(`Password-${suffix}!`);
		});
		const accountId = await page.evaluate(() =>
			localStorage.getItem("bittery_runtime_account_id"),
		);
		if (!accountId)
			throw new Error("Sign-up did not install a Runtime Account.");
		const upload = (await page.evaluate(
			async ({ accountId, itemId, suffix }) => {
				const cryptoModulePath = "/src/lib/crypto.ts";
				const { attachmentUploads, runtime } = await import(cryptoModulePath);
				const plaintext = new TextEncoder().encode(`ticket-28-d-${suffix}`);
				let offset = 0;
				const sourceCapabilityId = attachmentUploads.grant({
					accountId,
					itemId,
					name: `move-${suffix}.txt`,
					contentType: "text/plain",
					expectedBytes: BigInt(plaintext.byteLength),
					source: {
						async read(maxBytes: number) {
							if (offset === plaintext.byteLength) return null;
							const chunk = plaintext.slice(offset, offset + maxBytes);
							offset += chunk.byteLength;
							return chunk;
						},
						async close() {},
					},
				});
				return JSON.parse(
					await runtime.request(
						"ticket-28-d-upload",
						JSON.stringify({
							type: "uploadAttachment",
							accountId,
							itemId,
							name: `move-${suffix}.txt`,
							contentType: "text/plain",
							fileSize: String(plaintext.byteLength),
							sourceCapabilityId,
						}),
					),
				);
			},
			{ accountId, itemId, suffix },
		)) as {
			type: string;
			value?: { type: string; attachmentId?: string };
		};
		expect(upload).toMatchObject({
			type: "succeeded",
			value: { type: "attachmentUploaded" },
		});
		const attachmentId = upload.value?.attachmentId;
		if (!attachmentId)
			throw new Error("Attachment upload omitted its Attachment ID.");

		preparationActive = true;
		const accepted = await page.evaluate(
			async ({ accountId, itemId, targetVaultId }) => {
				const cryptoModulePath = "/src/lib/crypto.ts";
				const { runtime } = await import(cryptoModulePath);
				return JSON.parse(
					await runtime.request(
						"ticket-28-d-move",
						JSON.stringify({
							type: "moveItem",
							accountId,
							itemId,
							targetVaultId,
						}),
					),
				) as {
					type: string;
					value?: { type: string; operationId?: string };
				};
			},
			{ accountId, itemId, targetVaultId: moveTargetVaultId },
		);
		expect(accepted).toMatchObject({
			type: "succeeded",
			value: { type: "accepted" },
		});
		const operationId = accepted.value?.operationId;
		if (!operationId)
			throw new Error("Move acceptance omitted its Operation ID.");
		expectedResumedManifestPath = `/api/v1/operations/${operationId}/attachment-move-manifest`;

		await expect
			.poll(() => manifestFailures, { timeout: 180_000 })
			.toBe(PREPARATION_FAILURES);
		const pendingRows = await replicaRows(page, "attachment_move_preparations");
		expect(pendingRows).toHaveLength(1);
		const pending = JSON.parse(pendingRows[0]?.payloadJson ?? "{}") as {
			operationId?: string;
			scheduling?: { attemptCount?: string };
		};
		expect(pending.operationId).toBe(operationId);
		expect(Number(pending.scheduling?.attemptCount)).toBeGreaterThan(5);

		// Lock stops preparation before the orphan fixture is inserted. Reload replaces
		// the production Worker; only the subsequent Quick Unlock may reacquire the
		// browser Account lease, sweep, and resume the durable Move.
		await page.evaluate(async (accountId) => {
			const cryptoModulePath = "/src/lib/crypto.ts";
			const { runtimeClient } = await import(cryptoModulePath);
			await runtimeClient.lock(accountId);
		}, accountId);
		await seedOrphanArtifact(page, accountId);
		expect(await orphanArtifactRows(page, accountId)).toEqual([1, 1, 1, 1]);
		restartBaseline = {
			manifestCalls,
			manifestFailures,
			downloadAttempts,
			stagingUploads,
			moveDispatches,
		};
		resumedSweepPhase = "restart-before-unlock-arm";
		const initialWorker = page
			.workers()
			.find((worker) => worker.url().includes("runtime.worker"));
		if (!initialWorker)
			throw new Error("The production Runtime Worker was absent.");
		const workerClosed = new Promise<void>((resolve) =>
			initialWorker.once("close", () => resolve()),
		);
		await page.reload();
		await workerClosed;
		await page.waitForLoadState("domcontentloaded");
		await expect(
			page.getByRole("button", { name: "Unlock Vault", exact: true }),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		await page.locator("#password").fill(user.password);
		expect({
			counters: {
				manifestCalls,
				manifestFailures,
				downloadAttempts,
				stagingUploads,
				moveDispatches,
			},
			requestsBeforeUnlockArm,
			objectRequestsBeforeBarrierRelease,
			concurrentResumedManifests,
			unexpectedResumedManifests,
			guardedPreparationBypasses,
		}).toEqual({
			counters: restartBaseline,
			requestsBeforeUnlockArm: [],
			objectRequestsBeforeBarrierRelease: [],
			concurrentResumedManifests: [],
			unexpectedResumedManifests: [],
			guardedPreparationBypasses: [],
		});
		resumedManifestInspectionArmed = true;
		resumedSweepPhase = "awaiting-first-manifest";
		await page
			.getByRole("button", { name: "Unlock Vault", exact: true })
			.click();
		try {
			await expect
				.poll(() => firstResumedManifestInspection !== undefined, {
					timeout: 120_000,
				})
				.toBe(true);
		} catch (error) {
			const [preparations, locks, orphans] = await Promise.all([
				replicaRows(page, "attachment_move_preparations"),
				page.evaluate(async () => {
					const snapshot = await navigator.locks.query();
					return {
						held: snapshot.held?.map(({ name }) => name),
						pending: snapshot.pending?.map(({ name }) => name),
					};
				}),
				orphanArtifactRows(page, accountId),
			]);
			throw new Error(
				`The exact resumed manifest did not reach the sweep barrier: ${JSON.stringify(
					{
						counters: {
							manifestCalls,
							manifestFailures,
							downloadAttempts,
							stagingUploads,
							moveDispatches,
						},
						restartBaseline,
						requestsBeforeUnlockArm,
						objectRequestsBeforeBarrierRelease,
						concurrentResumedManifests,
						unexpectedResumedManifests,
						guardedPreparationBypasses,
						preparations: preparations.map(({ payloadJson }) =>
							JSON.parse(payloadJson),
						),
						locks,
						orphans,
					},
				)}`,
				{ cause: error },
			);
		}
		const completedOrphanInspection = firstResumedManifestInspection;
		if (!completedOrphanInspection)
			throw new Error("The resumed manifest did not inspect orphan state.");
		expect(await completedOrphanInspection).toEqual([0, 0, 0, 0]);
		expect({
			counters: {
				manifestCalls,
				manifestFailures,
				downloadAttempts,
				stagingUploads,
				moveDispatches,
			},
			resumedManifestBarrierEntries,
			requestsBeforeUnlockArm,
			objectRequestsBeforeBarrierRelease,
			concurrentResumedManifests,
			unexpectedResumedManifests,
			guardedPreparationBypasses,
		}).toEqual({
			counters: {
				manifestCalls: restartBaseline.manifestCalls + 1,
				manifestFailures: restartBaseline.manifestFailures,
				downloadAttempts: restartBaseline.downloadAttempts,
				stagingUploads: restartBaseline.stagingUploads,
				moveDispatches: restartBaseline.moveDispatches,
			},
			resumedManifestBarrierEntries: [`PUT ${expectedResumedManifestPath}`],
			requestsBeforeUnlockArm: [],
			objectRequestsBeforeBarrierRelease: [],
			concurrentResumedManifests: [],
			unexpectedResumedManifests: [],
			guardedPreparationBypasses: [],
		});
		resumedSweepPhase = "downstream-open";
		resumedManifestReleased = true;
		releaseResumedManifest?.();
		await page.waitForURL("**/home", { timeout: VAULT_READY_TIMEOUT_MS });

		await expect.poll(() => stagingUploads, { timeout: 120_000 }).toBe(1);
		const productionArtifactRows = await artifactRows(page, accountId);
		expect(productionArtifactRows[1]).toBeGreaterThan(0);
		expect(productionArtifactRows[3]).toBeGreaterThan(0);
		stagingUploadReleased = true;
		releaseStagingUpload?.();

		await expect.poll(() => moveDispatches, { timeout: 120_000 }).toBe(1);
		const promotedOperation = promotedOperationRows?.find(
			(row) => row.recordId === operationId,
		);
		if (!promotedOperation)
			throw new Error("Move dispatch began without its durable Operation.");
		const promotedPayload = JSON.parse(promotedOperation.payloadJson) as {
			operationId?: string;
			kind?: string;
			itemId?: string;
			vaultId?: string;
		};
		expect(promotedPayload).toMatchObject({
			operationId,
			kind: "move_item",
			itemId,
			vaultId: moveTargetVaultId,
		});
		expect(
			promotedPreparationRows?.some((row) => row.recordId === operationId),
		).toBe(false);
		moveDispatchReleased = true;
		releaseMoveDispatch?.();

		await expect
			.poll(
				async () => {
					const [operations, preparations, receipts] = await Promise.all([
						replicaRows(page, "operations"),
						replicaRows(page, "attachment_move_preparations"),
						replicaRows(page, "operation_receipts"),
					]);
					const receiptRow = receipts.find(
						(row) => row.recordId === operationId,
					);
					const receipt = JSON.parse(receiptRow?.payloadJson ?? "{}") as {
						operationId?: string;
						kind?: string;
						itemId?: string;
						vaultId?: string;
						result?: { type?: string; entityId?: string };
					};
					return {
						operationRetained: operations.some(
							(row) => row.recordId === operationId,
						),
						preparationRetained: preparations.some(
							(row) => row.recordId === operationId,
						),
						receipt: {
							operationId: receipt.operationId,
							kind: receipt.kind,
							itemId: receipt.itemId,
							vaultId: receipt.vaultId,
							resultType: receipt.result?.type,
							entityId: receipt.result?.entityId,
						},
					};
				},
				{ timeout: 120_000 },
			)
			.toEqual({
				operationRetained: false,
				preparationRetained: false,
				receipt: {
					operationId,
					kind: "move_item",
					itemId,
					vaultId: moveTargetVaultId,
					resultType: "applied",
					entityId: itemId,
				},
			});
		const serverOutcomeResult = runE2eSql(`
			SELECT json_build_object(
				'kind', operation_kind::text,
				'status', result_status::text,
				'entityId', entity_id
			)::text
			FROM operation_outcome
			JOIN "user" ON "user".id = operation_outcome.user_id
			WHERE "user".email = '${sqlString(user.email)}'
			  AND operation_id = '${sqlString(operationId)}';
		`);
		expect(
			JSON.parse(serverOutcomeResult.match(/\{.*\}/s)?.[0] ?? "{}"),
		).toEqual({ kind: "move_item", status: "applied", entityId: itemId });

		// Promotion and dispatch are not convergence. The same reconciliation that
		// retains the receipt must project authoritative target Attachment state.
		await expect
			.poll(
				async () => {
					const [receipts, authorityItems] = await Promise.all([
						replicaRows(page, "operation_receipts"),
						replicaRows(page, "authority_items"),
					]);
					const authority = authorityItems
						.map(
							(row) =>
								JSON.parse(row.payloadJson) as {
									id?: string;
									vaultId?: string;
									attachments?: Array<{
										id?: string;
										itemId?: string;
										vaultId?: string;
									}>;
								},
						)
						.find((candidate) => candidate.id === itemId);
					const attachment = authority?.attachments?.find(
						(candidate) => candidate.id === attachmentId,
					);
					return {
						receiptRetained: receipts.some(
							(row) => row.recordId === operationId,
						),
						itemId: authority?.id,
						itemVaultId: authority?.vaultId,
						attachmentId: attachment?.id,
						attachmentItemId: attachment?.itemId,
						attachmentVaultId: attachment?.vaultId,
					};
				},
				{ timeout: 120_000 },
			)
			.toEqual({
				receiptRetained: true,
				itemId,
				itemVaultId: moveTargetVaultId,
				attachmentId,
				attachmentItemId: itemId,
				attachmentVaultId: moveTargetVaultId,
			});
		expect(manifestFailures).toBe(PREPARATION_FAILURES);
		expect(manifestCalls).toBeGreaterThan(PREPARATION_FAILURES);
		expect(downloadAttempts).toBeGreaterThan(0);
		expect(stagingUploads).toBe(1);
		await expect
			.poll(
				async () =>
					(await replicaRows(page, "attachment_move_preparations")).length,
			)
			.toBe(0);
	} finally {
		resumedSweepPhase = "downstream-open";
		releaseResumedManifest?.();
		releaseRejectedPreparationRoutes?.();
		releaseStagingUpload?.();
		releaseMoveDispatch?.();
		await context.close();
	}
});
