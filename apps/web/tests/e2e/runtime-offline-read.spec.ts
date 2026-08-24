import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	expect,
	generateTestUser,
	signIn,
	signUp,
	test,
} from "../fixtures/auth";
import { runE2eSql, sqlString } from "../fixtures/e2e-database";
import { uiText } from "../fixtures/messages";
import {
	createItem,
	detailRow,
	itemRow,
	openItem,
	VAULT_READY_TIMEOUT_MS,
	vaultNavLink,
} from "../fixtures/vault";

const TEST_BUDGET_MS = 480_000;

type ReplicaContents = Record<string, unknown[]>;
type StoredHead = { accountId: string; replicaRevision: string };
type StoredRow = {
	accountId: string;
	recordId: string;
	payloadJson: string;
};
type RuntimeObservationCommand = {
	type: "observe" | "unobserve";
	observationId: string;
	requestJson?: string;
};
type TransportRecord = { method: string; pathname: string };

const CLOUD_SERVER_DIAGNOSTIC_LOG = new URL(
	"../../../../node_modules/.cache/e2e-tmp/cloud-api.log",
	import.meta.url,
);

async function databaseContents(
	page: Page,
	databaseName: string,
): Promise<Record<string, unknown[]> | null> {
	return page.evaluate(async (name) => {
		const databases = await indexedDB.databases();
		if (!databases.some((database) => database.name === name)) return null;
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(name);
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
	}, databaseName);
}

async function installRuntimeObservationProbe(
	context: BrowserContext,
): Promise<void> {
	await context.addInitScript(() => {
		const scope = globalThis as typeof globalThis & {
			__ticket36RuntimeCommands?: Array<{
				type: "observe" | "unobserve";
				observationId: string;
				requestJson?: string;
			}>;
		};
		scope.__ticket36RuntimeCommands = [];
		const originalPostMessage = Worker.prototype.postMessage;
		Worker.prototype.postMessage = function postMessage(
			this: Worker,
			message: unknown,
			...rest: unknown[]
		) {
			if (typeof message === "object" && message !== null) {
				const envelope = message as {
					type?: unknown;
					channel?: unknown;
					payload?: unknown;
				};
				if (
					envelope.type === "request" &&
					envelope.channel === "runtime" &&
					typeof envelope.payload === "object" &&
					envelope.payload !== null
				) {
					const payload = envelope.payload as {
						type?: unknown;
						observationId?: unknown;
						requestJson?: unknown;
					};
					if (
						(payload.type === "observe" || payload.type === "unobserve") &&
						typeof payload.observationId === "string"
					) {
						scope.__ticket36RuntimeCommands?.push({
							type: payload.type,
							observationId: payload.observationId,
							...(typeof payload.requestJson === "string"
								? { requestJson: payload.requestJson }
								: {}),
						});
					}
				}
			}
			return Reflect.apply(originalPostMessage, this, [message, ...rest]);
		} as typeof Worker.prototype.postMessage;
	});
}

async function runtimeObservationCommands(
	page: Page,
): Promise<RuntimeObservationCommand[]> {
	return page.evaluate(
		() =>
			(
				globalThis as typeof globalThis & {
					__ticket36RuntimeCommands?: RuntimeObservationCommand[];
				}
			).__ticket36RuntimeCommands ?? [],
	);
}

function observesItemsFor(
	command: RuntimeObservationCommand,
	accountId: string,
): boolean {
	if (command.type !== "observe" || command.requestJson === undefined) {
		return false;
	}
	try {
		const request = JSON.parse(command.requestJson) as {
			type?: unknown;
			accountId?: unknown;
		};
		return request.type === "items" && request.accountId === accountId;
	} catch {
		return false;
	}
}

async function replicaContents(page: Page): Promise<ReplicaContents> {
	const contents = await databaseContents(page, "bittery_replica");
	if (contents === null)
		throw new Error("The Runtime Replica database is absent.");
	return contents;
}

function explicitReplicaAccount(contents: ReplicaContents): string {
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

function authorityItem(
	contents: ReplicaContents,
	itemId: string,
): { row: StoredRow; payload: Record<string, unknown> } | null {
	for (const row of contents.authority_items as StoredRow[]) {
		const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
		if (payload.id === itemId) return { row, payload };
	}
	return null;
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

async function installTransportControl(context: BrowserContext): Promise<{
	disconnect: () => void;
	attemptedAfterDisconnect: TransportRecord[];
	responsesAfterDisconnect: TransportRecord[];
}> {
	let disconnected = false;
	const attemptedAfterDisconnect: TransportRecord[] = [];
	const responsesAfterDisconnect: TransportRecord[] = [];

	context.on("response", (response) => {
		if (disconnected && response.url().includes("/api/v1/")) {
			responsesAfterDisconnect.push({
				method: response.request().method(),
				pathname: new URL(response.url()).pathname,
			});
		}
	});
	// Ticket 30 owns held-SSE reconnect and backoff. Online ceremonies receive one
	// deterministic finite hint; after disconnection the later general route aborts it.
	await context.route("**/api/v1/sync/events", (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/event-stream",
			body: "event: ping\ndata: {}\n\n",
		}),
	);
	await context.route("**/api/v1/**", async (route) => {
		if (!disconnected) {
			await route.fallback();
			return;
		}
		attemptedAfterDisconnect.push({
			method: route.request().method(),
			pathname: new URL(route.request().url()).pathname,
		});
		await route.abort("internetdisconnected");
	});

	return {
		disconnect: () => {
			disconnected = true;
		},
		attemptedAfterDisconnect,
		responsesAfterDisconnect,
	};
}

test("a replaced Runtime renders bootstrapped encrypted authority after transport disconnection", async ({
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);

	const suffix = nanoid(6);
	const title = `Offline authority ${suffix}`;
	const plaintextMarker = `PLAINTEXT-OFFLINE-AUTHORITY-${suffix}`;
	const consoleMessages: string[] = [];
	const seedContext = await browser.newContext();
	const authorityContext = await browser.newContext();
	await installRuntimeObservationProbe(authorityContext);
	await installTransportControl(seedContext);
	const authorityTransport = await installTransportControl(authorityContext);

	try {
		const seedPage = await seedContext.newPage();
		seedPage.on("console", (message) => consoleMessages.push(message.text()));
		const user = await signUp(seedPage, generateTestUser());
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

		await openRuntimeVault(seedPage, vaultId);
		const itemId = await createItem(seedPage, "login", async (sheet) => {
			await sheet.locator("#title").fill(title);
			await sheet.locator("#username").fill(plaintextMarker);
			await sheet.locator("#password").fill(`Password-${suffix}!`);
		});
		await expect(seedPage.getByTestId("item-status-pending")).toHaveCount(0, {
			timeout: 120_000,
		});
		await expect
			.poll(
				async () =>
					authorityItem(await replicaContents(seedPage), itemId) !== null,
				{ timeout: 120_000 },
			)
			.toBe(true);
		// A fresh browser profile can only learn the Runtime-created Item through the
		// bounded Rust Bootstrap. It has neither the seed profile's Replica nor its
		// transitional record database.
		let page = await authorityContext.newPage();
		page.on("console", (message) => consoleMessages.push(message.text()));
		await signIn(page, user);
		await openRuntimeVault(page, vaultId);
		await expect(itemRow(page, title)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect
			.poll(
				async () => authorityItem(await replicaContents(page), itemId) !== null,
				{ timeout: VAULT_READY_TIMEOUT_MS },
			)
			.toBe(true);

		const bootstrappedReplica = await replicaContents(page);
		const accountId = explicitReplicaAccount(bootstrappedReplica);
		const bootstrappedAuthority = authorityItem(bootstrappedReplica, itemId);
		expect(bootstrappedAuthority).not.toBeNull();
		const metadataRows = bootstrappedReplica.replica_metadata as StoredRow[];
		expect(metadataRows).toHaveLength(1);
		const bootstrapMetadata = JSON.parse(
			metadataRows[0]?.payloadJson ?? "{}",
		) as {
			state?: string;
			activeGeneration?: string | null;
			stagingGeneration?: string | null;
		};
		expect(bootstrapMetadata).toMatchObject({
			state: "ready",
			stagingGeneration: null,
		});
		expect(bootstrapMetadata.activeGeneration).toBeTruthy();
		expect(bootstrappedAuthority?.payload).toMatchObject({
			id: itemId,
			vaultId,
			category: "login",
			version: 1,
		});
		expect(bootstrappedAuthority?.row.accountId).toBe(accountId);
		expect(bootstrappedAuthority?.row.recordId).toBe(
			`${bootstrapMetadata.activeGeneration}/${itemId}`,
		);
		expect(bootstrappedAuthority?.row.payloadJson).not.toContain(
			plaintextMarker,
		);
		expect(JSON.stringify(bootstrappedReplica)).not.toContain(plaintextMarker);
		const legacyBeforeRestart = await databaseContents(page, "bittery_records");
		expect(JSON.stringify(legacyBeforeRestart)).not.toContain(itemId);
		expect(JSON.stringify(legacyBeforeRestart)).not.toContain(plaintextMarker);

		const initialWorkers = page
			.workers()
			.filter((worker) => worker.url().includes("runtime.worker"));
		expect(initialWorkers).toHaveLength(1);
		const initialWorker = initialWorkers[0];
		if (!initialWorker) throw new Error("The Runtime Worker was not running.");
		const initialWorkerClosed = new Promise<void>((resolve) =>
			initialWorker.once("close", () => resolve()),
		);
		await page.close();
		await initialWorkerClosed;

		// A new Page replaces both the browser document process and its dedicated
		// Runtime Worker while preserving only this browser profile's durable stores.
		page = await authorityContext.newPage();
		page.on("console", (message) => consoleMessages.push(message.text()));
		await page.goto("/home");
		await expect(
			page.getByRole("button", { name: "Unlock Vault", exact: true }),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		const replacementWorkers = page
			.workers()
			.filter((worker) => worker.url().includes("runtime.worker"));
		expect(replacementWorkers).toHaveLength(1);
		const replacementWorker = replacementWorkers[0];
		expect(replacementWorker).not.toBe(initialWorker);
		const lockedReplica = await replicaContents(page);
		expect(explicitReplicaAccount(lockedReplica)).toBe(accountId);
		expect(authorityItem(lockedReplica, itemId)?.row.payloadJson).toBe(
			bootstrappedAuthority?.row.payloadJson,
		);

		await page.locator("#password").fill(user.password);
		await page
			.getByRole("button", { name: "Unlock Vault", exact: true })
			.click();
		await page.waitForURL("**/home", { timeout: 120_000 });
		await expect(page.locator("#app-scroll-area")).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		let firstItemsObservationId: string | undefined;
		await expect
			.poll(async () => {
				const commands = await runtimeObservationCommands(page);
				firstItemsObservationId = commands.find((command) =>
					observesItemsFor(command, accountId),
				)?.observationId;
				return firstItemsObservationId;
			})
			.toBeTruthy();
		if (firstItemsObservationId === undefined) {
			throw new Error("The home Items observation did not reach the Worker.");
		}

		// Settings has no Items consumer. Moving there removes the home projection;
		// the later Vault navigation creates a new observation after transport is gone.
		await page
			.getByRole("link", { name: "Settings", exact: true })
			.first()
			.click();
		await page.waitForURL("**/settings");
		await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect
			.poll(async () => {
				const commands = await runtimeObservationCommands(page);
				return commands.some(
					(command) =>
						command.type === "unobserve" &&
						command.observationId === firstItemsObservationId,
				);
			})
			.toBe(true);
		authorityTransport.disconnect();

		await openRuntimeVault(page, vaultId);
		let offlineItemsObservationId: string | undefined;
		await expect
			.poll(async () => {
				const commands = await runtimeObservationCommands(page);
				offlineItemsObservationId = commands.find(
					(command) =>
						observesItemsFor(command, accountId) &&
						command.observationId !== firstItemsObservationId,
				)?.observationId;
				return offlineItemsObservationId;
			})
			.toBeTruthy();
		await expect(itemRow(page, title)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await openItem(page, title);
		await expect(
			detailRow(
				page.getByTestId("item-detail-pane"),
				uiText("vaults_detail_items_detail_login_field_username"),
			),
		).toContainText(plaintextMarker);

		const offlineReplica = await replicaContents(page);
		expect(explicitReplicaAccount(offlineReplica)).toBe(accountId);
		expect(authorityItem(offlineReplica, itemId)?.row.payloadJson).toBe(
			bootstrappedAuthority?.row.payloadJson,
		);
		expect(JSON.stringify(offlineReplica)).not.toContain(plaintextMarker);
		const legacyOffline = await databaseContents(page, "bittery_records");
		expect(JSON.stringify(legacyOffline)).not.toContain(itemId);
		expect(JSON.stringify(legacyOffline)).not.toContain(plaintextMarker);

		const observationCommands = await runtimeObservationCommands(page);
		const itemObserves = observationCommands.filter((command) =>
			observesItemsFor(command, accountId),
		);
		expect(itemObserves).toHaveLength(2);
		expect(itemObserves.map((command) => command.observationId)).toEqual([
			firstItemsObservationId,
			offlineItemsObservationId,
		]);
		expect(observationCommands).toContainEqual({
			type: "unobserve",
			observationId: firstItemsObservationId,
		});
		const offlineReadPaths = new Set([
			"/api/v1/sync/bootstrap",
			"/api/v1/sync/changes",
			`/api/v1/items/${itemId}`,
		]);
		test.info().annotations.push({
			type: "post-disconnect-api-attempts",
			description: JSON.stringify(authorityTransport.attemptedAfterDisconnect),
		});
		expect(
			authorityTransport.responsesAfterDisconnect.filter((record) =>
				offlineReadPaths.has(record.pathname),
			),
		).toEqual([]);
		// Attempts are deliberately not constrained here: ticket 30 decides catch-up and
		// held-SSE reconnect/backoff. The catch-all still aborts them, and this proves no
		// Bootstrap, changes, exact Item GET, SSE, or other API response supplied the Item.
		expect(authorityTransport.responsesAfterDisconnect).toEqual([]);
		expect(consoleMessages.join("\n")).not.toContain(plaintextMarker);
		expect(readFileSync(CLOUD_SERVER_DIAGNOSTIC_LOG, "utf8")).not.toContain(
			plaintextMarker,
		);
		const serverFacts = JSON.parse(
			runE2eSql(`
				SELECT json_build_object(
					'items', (SELECT count(*) FROM item WHERE id = '${sqlString(itemId)}'),
					'plaintext', (SELECT count(*) FROM item WHERE id = '${sqlString(itemId)}' AND encrypted_data LIKE '%${sqlString(plaintextMarker)}%')
				)::text;
			`).match(/\{.*\}/s)?.[0] ?? "{}",
		);
		expect(serverFacts).toEqual({ items: 1, plaintext: 0 });
	} finally {
		await Promise.all([seedContext.close(), authorityContext.close()]);
	}
});
