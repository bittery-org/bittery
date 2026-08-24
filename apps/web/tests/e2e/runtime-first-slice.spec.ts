import { readFileSync } from "node:fs";
import type { Page, Route } from "@playwright/test";
import { nanoid } from "nanoid";
import { expect, generateTestUser, signUp, test } from "../fixtures/auth";
import { runE2eSql, sqlString } from "../fixtures/e2e-database";
import {
	createItem,
	itemRow,
	VAULT_READY_TIMEOUT_MS,
	vaultNavLink,
} from "../fixtures/vault";

const TEST_BUDGET_MS = 420_000;
const TRANSIENT_FAILURES = 6;
const CLOUD_API_ORIGIN = "http://localhost:3010";

type ReplicaContents = Record<string, unknown[]>;

type StoredHead = { accountId: string; replicaRevision: string };
type StoredRow = {
	accountId: string;
	recordId: string;
	payloadJson: string;
};

const CLOUD_SERVER_DIAGNOSTIC_LOG = new URL(
	"../../../../node_modules/.cache/e2e-tmp/cloud-api.log",
	import.meta.url,
);

async function replicaContents(page: Page): Promise<ReplicaContents> {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("bittery_replica");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const stores = [...database.objectStoreNames];
			const transaction = database.transaction(stores, "readonly");
			const entries = await Promise.all(
				stores.map(
					(storeName) =>
						new Promise<[string, unknown[]]>((resolve, reject) => {
							const request = transaction.objectStore(storeName).getAll();
							request.onsuccess = () =>
								resolve([storeName, request.result as unknown[]]);
							request.onerror = () => reject(request.error);
						}),
				),
			);
			return Object.fromEntries(entries);
		} finally {
			database.close();
		}
	});
}

function operationId(route: Route): string | undefined {
	return route.request().headers()["idempotency-key"];
}

function replicaAccountId(contents: ReplicaContents): string {
	const heads = contents.heads as StoredHead[];
	expect(heads).toHaveLength(1);
	const accountId = heads[0]?.accountId;
	expect(accountId).toBeTruthy();
	for (const [store, values] of Object.entries(contents)) {
		if (store === "heads") continue;
		for (const value of values as StoredRow[]) {
			expect(value.accountId, `${store}/${value.recordId}`).toBe(accountId);
		}
	}
	return accountId ?? "";
}

function onlyStoredRow(contents: ReplicaContents, store: string): StoredRow {
	const rows = contents[store] as StoredRow[];
	expect(rows).toHaveLength(1);
	const row = rows[0];
	if (!row) throw new Error(`Replica store ${store} lost its only row.`);
	return row;
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

test("the Rust Runtime durably reconciles an offline create after restart and repeated transport loss", async ({
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);

	const context = await browser.newContext();
	const page = await context.newPage();
	const suffix = nanoid(6);
	const title = `Runtime durable ${suffix}`;
	const plaintextMarker = `PLAINTEXT-RUNTIME-${suffix}`;
	const requestBodies: string[] = [];
	const observedOperationIds: string[] = [];
	const preparedRequests: Array<{
		method: string;
		url: string;
		contentType: string | undefined;
	}> = [];
	const consoleMessages: string[] = [];
	const heldDispatchResolvers: Array<(decision: "abort" | "proceed") => void> =
		[];
	let dispatchReleased = false;
	let heldDispatches = 0;
	let putAttempts = 0;
	let refreshes = 0;
	let successfulResponseLost = false;
	let hiddenOutcomeOnce = false;

	page.on("console", (message) => consoleMessages.push(message.text()));

	try {
		// Ticket 30 owns long-held SSE reconnect policy. This reconciliation test
		// supplies one deterministic finite wakeup frame, so it exercises the real
		// Runtime transport without inventing reconnect or backoff behaviour here.
		await page.route("**/api/v1/sync/events", (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: "event: ping\ndata: {}\n\n",
			}),
		);
		const user = await signUp(page, generateTestUser());
		const vaultId = runE2eSql(`
			SELECT vault.id
			FROM vault
			JOIN "user" ON "user".id = vault.created_by_id
			WHERE "user".email = '${sqlString(user.email)}' AND vault.type = 'personal'
			LIMIT 1;
		`)
			.split("\n")
			.find((line) => /^[0-9a-f-]{36}$/.test(line.trim()))
			?.trim();
		if (!vaultId) throw new Error("Signup did not create a personal Vault.");
		await openRuntimeVault(page, vaultId);

		await context.route("**/api/v1/**", async (route) => {
			const request = route.request();
			const pathname = new URL(request.url()).pathname;
			if (pathname === "/api/v1/sessions/current/refresh") {
				refreshes += 1;
				await route.continue();
				return;
			}

			if (
				request.method() === "GET" &&
				pathname.startsWith("/api/v1/operations/") &&
				successfulResponseLost &&
				!hiddenOutcomeOnce
			) {
				hiddenOutcomeOnce = true;
				await route.fulfill({ status: 404, body: "" });
				return;
			}

			if (
				request.method() !== "PUT" ||
				!pathname.startsWith(`/api/v1/vaults/${vaultId}/items/`)
			) {
				await route.continue();
				return;
			}

			requestBodies.push(request.postData() ?? "");
			preparedRequests.push({
				method: request.method(),
				url: request.url(),
				contentType: request.headers()["content-type"],
			});
			const id = operationId(route);
			if (!id) {
				throw new Error(
					"Runtime dispatch omitted its durable Idempotency key.",
				);
			}
			observedOperationIds.push(id);
			if (!dispatchReleased) {
				heldDispatches += 1;
				const decision = await new Promise<"abort" | "proceed">((resolve) =>
					heldDispatchResolvers.push(resolve),
				);
				if (decision === "abort") {
					await route.abort("connectionreset");
					return;
				}
			}

			putAttempts += 1;

			if (putAttempts <= TRANSIENT_FAILURES) {
				await route.abort("connectionreset");
				return;
			}
			if (putAttempts === TRANSIENT_FAILURES + 1) {
				await route.fulfill({ status: 401, body: "" });
				return;
			}
			if (putAttempts === TRANSIENT_FAILURES + 2) {
				await route.fetch();
				successfulResponseLost = true;
				await route.abort("connectionreset");
				return;
			}
			await route.continue();
		});

		await createItem(page, "login", async (sheet) => {
			await sheet.locator("#title").fill(title);
			await sheet.locator("#username").fill(plaintextMarker);
			await sheet.locator("#password").fill(`Password-${suffix}!`);
		});
		const itemId = await page
			.getByTestId("item-detail-pane")
			.getAttribute("data-item-id");
		if (!itemId)
			throw new Error("The accepted create did not expose an Item ID.");
		await expect(page.getByTestId("item-detail-status-pending")).toBeVisible();

		const acceptedReplica = await replicaContents(page);
		const persistedAccountId = replicaAccountId(acceptedReplica);
		expect(acceptedReplica.operations).toHaveLength(1);
		expect(acceptedReplica.optimistic_items).toHaveLength(1);
		expect(JSON.stringify(acceptedReplica)).not.toContain(plaintextMarker);
		const acceptedOperationRow = onlyStoredRow(acceptedReplica, "operations");
		const acceptedOperation = JSON.parse(acceptedOperationRow.payloadJson) as {
			operationId: string;
			itemId: string;
			vaultId: string;
			requestFingerprint: string;
			request: {
				method: string;
				path: string;
				headers: Array<{ name: string; value: string }>;
				body: number[];
			};
		};
		expect(acceptedOperation).toMatchObject({
			itemId,
			vaultId,
			request: {
				method: "PUT",
				path: `/api/v1/vaults/${vaultId}/items/${itemId}`,
				headers: [{ name: "Content-Type", value: "application/json" }],
			},
		});
		expect(acceptedOperation.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(acceptedOperationRow.recordId).toBe(acceptedOperation.operationId);
		const durableRequestBody = new TextDecoder().decode(
			Uint8Array.from(acceptedOperation.request.body),
		);
		expect(durableRequestBody).not.toContain(plaintextMarker);
		await expect.poll(() => heldDispatches).toBeGreaterThanOrEqual(1);
		expect(putAttempts).toBe(0);
		expect(successfulResponseLost).toBe(false);
		const beforeRestartFacts = JSON.parse(
			runE2eSql(`
				SELECT json_build_object(
					'items', (SELECT count(*) FROM item WHERE id = '${sqlString(itemId)}'),
					'outcomes', (SELECT count(*) FROM operation_outcome WHERE operation_id = '${sqlString(acceptedOperation.operationId)}')
				)::text;
			`).match(/\{.*\}/s)?.[0] ?? "{}",
		);
		expect(beforeRestartFacts).toEqual({ items: 0, outcomes: 0 });

		// Reloading tears down the process-owned Worker. The route remains intercepted,
		// so the new Worker can only restore the accepted Operation from IndexedDB.
		const initialRuntimeWorkers = page
			.workers()
			.filter((worker) => worker.url().includes("runtime.worker"));
		expect(initialRuntimeWorkers).toHaveLength(1);
		const initialWorker = initialRuntimeWorkers[0];
		if (!initialWorker) throw new Error("The Runtime Worker was not running.");
		const initialWorkerClosed = new Promise<void>((resolve) =>
			initialWorker.once("close", () => resolve()),
		);
		await page.reload();
		await initialWorkerClosed;
		for (const resolveHeldDispatch of heldDispatchResolvers.splice(0)) {
			resolveHeldDispatch("abort");
		}
		await page.waitForLoadState("domcontentloaded");
		await expect
			.poll(
				() => {
					const runtimeWorkers = page
						.workers()
						.filter((worker) => worker.url().includes("runtime.worker"));
					return (
						runtimeWorkers.length === 1 && runtimeWorkers[0] !== initialWorker
					);
				},
				{ timeout: VAULT_READY_TIMEOUT_MS },
			)
			.toBe(true);
		const restoredReplica = await replicaContents(page);
		expect(replicaAccountId(restoredReplica)).toBe(persistedAccountId);
		expect(restoredReplica.operations).toHaveLength(1);
		expect(restoredReplica.optimistic_items).toHaveLength(1);
		expect(onlyStoredRow(restoredReplica, "operations").payloadJson).toBe(
			acceptedOperationRow.payloadJson,
		);
		await expect(
			page.getByRole("button", { name: "Unlock Vault", exact: true }),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		await page.locator("#password").fill(user.password);
		await page
			.getByRole("button", { name: "Unlock Vault", exact: true })
			.click();
		await page.waitForURL("**/home", { timeout: VAULT_READY_TIMEOUT_MS });

		// Leaving the vault removes the initiating Items subscription. Dispatch belongs
		// to the Runtime process and must continue without that UI observer.
		expect(new URL(page.url()).pathname).toBe("/home");
		await expect(page.getByTestId("item-row")).toHaveCount(0);
		dispatchReleased = true;
		for (const resolveHeldDispatch of heldDispatchResolvers.splice(0)) {
			resolveHeldDispatch("proceed");
		}
		await expect
			.poll(() => putAttempts, { timeout: 240_000 })
			.toBeGreaterThanOrEqual(TRANSIENT_FAILURES + 3);
		expect(refreshes).toBeGreaterThanOrEqual(1);
		expect(successfulResponseLost).toBe(true);
		expect(hiddenOutcomeOnce).toBe(true);
		expect(observedOperationIds).toHaveLength(requestBodies.length);
		expect(observedOperationIds).toHaveLength(preparedRequests.length);
		expect(new Set(requestBodies).size).toBe(1);
		expect(new Set(observedOperationIds).size).toBe(1);
		expect(observedOperationIds).not.toHaveLength(0);
		expect(
			observedOperationIds.every(
				(operationId) => operationId === acceptedOperation.operationId,
			),
		).toBe(true);
		expect(requestBodies.every((body) => body === durableRequestBody)).toBe(
			true,
		);
		expect(
			new Set(preparedRequests.map((request) => JSON.stringify(request))),
		).toEqual(
			new Set([
				JSON.stringify({
					method: "PUT",
					url: `${CLOUD_API_ORIGIN}/api/v1/vaults/${vaultId}/items/${itemId}`,
					contentType: "application/json",
				}),
			]),
		);

		await openRuntimeVault(page, vaultId);
		await expect(itemRow(page, title)).toHaveCount(1);
		await expect(page.getByTestId("item-status-pending")).toHaveCount(0);
		await expect(page.getByTestId("item-status-failed")).toHaveCount(0);

		const operation = observedOperationIds[0];
		if (!operation) {
			throw new Error("The accepted create did not expose durable identities.");
		}
		const reconciledReplica = await replicaContents(page);
		expect(replicaAccountId(reconciledReplica)).toBe(persistedAccountId);
		expect(reconciledReplica.operations).toHaveLength(0);
		expect(reconciledReplica.optimistic_items).toHaveLength(0);
		expect(reconciledReplica.operation_receipts).toHaveLength(1);
		expect(JSON.stringify(reconciledReplica)).not.toContain(plaintextMarker);
		const receiptRow = onlyStoredRow(reconciledReplica, "operation_receipts");
		expect(receiptRow.recordId).toBe(operation);
		const receipt = JSON.parse(receiptRow.payloadJson) as Record<
			string,
			unknown
		>;
		expect(Object.keys(receipt).sort()).toEqual(
			[
				"completedAtRevision",
				"itemId",
				"kind",
				"operationId",
				"requestFingerprint",
				"result",
				"vaultId",
			].sort(),
		);
		expect(receipt).toEqual({
			operationId: operation,
			kind: "create_item",
			itemId,
			vaultId,
			requestFingerprint: acceptedOperation.requestFingerprint,
			result: { type: "applied", entityId: itemId, version: 1 },
			completedAtRevision: (reconciledReplica.heads as StoredHead[])[0]
				?.replicaRevision,
		});
		expect(receiptRow.payloadJson).not.toContain('"request":');
		expect(receiptRow.payloadJson).not.toContain('"body":');
		expect(receiptRow.payloadJson).not.toContain('"encryptedData":');

		const serverFacts = runE2eSql(`
			WITH subject AS (
				SELECT id FROM "user" WHERE email = '${sqlString(user.email)}'
			)
			SELECT json_build_object(
				'items', (SELECT count(*) FROM item WHERE id = '${sqlString(itemId)}'),
				'audits', (SELECT count(*) FROM audit_log WHERE user_id = (SELECT id FROM subject) AND entity_id = '${sqlString(itemId)}' AND action = 'item_created'),
				'item_events', (SELECT count(*) FROM sync_event WHERE user_id = (SELECT id FROM subject) AND entity_id = '${sqlString(itemId)}' AND event_type = 'item_created'),
				'outcomes', (SELECT count(*) FROM operation_outcome WHERE user_id = (SELECT id FROM subject) AND operation_id = '${sqlString(operation)}'),
				'operation_events', (SELECT count(*) FROM sync_event WHERE user_id = (SELECT id FROM subject) AND entity_id = '${sqlString(operation)}' AND event_type = 'operation_resolved'),
				'plaintext', (
					SELECT count(*) FROM (
						SELECT encrypted_data AS value FROM item WHERE id = '${sqlString(itemId)}'
						UNION ALL SELECT metadata FROM audit_log WHERE user_id = (SELECT id FROM subject)
						UNION ALL SELECT metadata FROM sync_event WHERE user_id = (SELECT id FROM subject)
						UNION ALL SELECT rejection_details::text FROM operation_outcome WHERE user_id = (SELECT id FROM subject)
					) diagnostics WHERE value LIKE '%${sqlString(plaintextMarker)}%'
				)
			)::text;
		`);
		const facts = JSON.parse(serverFacts.match(/\{.*\}/s)?.[0] ?? "{}");
		expect(facts).toEqual({
			items: 1,
			audits: 1,
			item_events: 1,
			outcomes: 1,
			operation_events: 1,
			plaintext: 0,
		});
		const serverDiagnostics = readFileSync(CLOUD_SERVER_DIAGNOSTIC_LOG, "utf8");
		expect(serverDiagnostics).toContain(
			"method=PUT path=/api/v1/vaults/{vaultId}/items/{itemId}",
		);
		expect(serverDiagnostics).not.toContain(plaintextMarker);
		expect(consoleMessages.join("\n")).not.toContain(plaintextMarker);
	} finally {
		await context.close();
	}
});
