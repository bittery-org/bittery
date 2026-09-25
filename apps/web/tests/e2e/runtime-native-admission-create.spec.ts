import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import {
	expect,
	generateTestUser,
	signUp,
	type TestUser,
	test,
} from "../fixtures/auth";
import { nativeCreateLossSource } from "../fixtures/native-create-loss-source";
import { nativeNetwork } from "../fixtures/native-network";
import {
	captureFixtureAccount,
	deleteFixtureUser,
} from "../fixtures/runtime-account-cleanup";
import { createVault } from "../fixtures/vault";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../../../..");

async function selectNetworkMode(
	control: string,
	acknowledgement: string,
	mode: string,
) {
	await writeFile(control, mode, { mode: 0o600 });
	await expect
		.poll(() => readFile(acknowledgement, "utf8"), { timeout: 10_000 })
		.toBe(mode);
}

test("admitted legacy Create reconciles the retained real Server outcome", async ({
	page,
	browser,
}) => {
	test.skip(
		process.env.BITTERY_NATIVE_FOUNDATION !== "1",
		"Requires the dev Server/database, native Desktop toolchain, and real OS keychain",
	);
	test.setTimeout(480_000);
	let user: TestUser | undefined;
	let fixtureAccount:
		| Awaited<ReturnType<typeof captureFixtureAccount>>
		| undefined;
	let directory: string | undefined;
	let network: Awaited<ReturnType<typeof nativeNetwork>> | undefined;
	let legacy: Page | undefined;
	let signupAttempted = false;
	let accepted = false;
	let cleanupFailed = false;
	try {
		user = generateTestUser();
		signupAttempted = true;
		user = await signUp(page, user);
		fixtureAccount = await captureFixtureAccount(page, user.email);
		const vaultId = await createVault(page, "Native admitted lost Create");
		directory = await mkdtemp(join(tmpdir(), "bittery-native-create-loss-"));
		const credentials = join(directory, "credentials.json");
		network = await nativeNetwork(directory);
		const createNetwork = network;
		const itemId = crypto.randomUUID();
		const operationId = crypto.randomUUID();
		const sourceCommandId = crypto.randomUUID();
		const attemptId = crypto.randomUUID();
		const itemTitle = `Native retained Create ${Date.now()}`;
		legacy = await browser.newPage();
		await legacy.goto(new URL(page.url()).origin, {
			waitUntil: "domcontentloaded",
		});
		const source = await nativeCreateLossSource(legacy, {
			user,
			serverUrl: createNetwork.serverUrl,
			vaultId,
			itemId,
			operationId,
			sourceCommandId,
			attemptId,
			itemTitle,
		});
		const before = await source.capture();
		await writeFile(
			createNetwork.createTarget,
			JSON.stringify({ vaultId, itemId, operationId }),
			{ mode: 0o600 },
		);
		await selectNetworkMode(
			createNetwork.control,
			createNetwork.acknowledgement,
			"create-loss",
		);
		await source.start();
		await expect
			.poll(() => createNetwork.lostCreates, { timeout: 30_000 })
			.toBe(1);
		const held = await source.capture();
		expect(held).toEqual(before);
		expect(createNetwork.createRequests).toHaveLength(1);
		const originalRequest = createNetwork.createRequests[0];
		expect(originalRequest).toBeDefined();
		const syncDocument = JSON.parse(
			Buffer.from(before.syncStoreJson).toString("utf8"),
		) as Record<string, string>;
		const queueDocument = JSON.parse(
			syncDocument.bittery_pending_mutation_queues_v3 ?? "null",
		) as Record<string, Array<Record<string, unknown>>> | null;
		const command = queueDocument?.[before.accountId]?.[0];
		expect(command).toMatchObject({
			id: sourceCommandId,
			operationId,
			attemptId,
			entityId: itemId,
			vaultId,
			type: "create",
			status: "pending",
			retryCount: 0,
		});
		const payload = command?.encryptedPayload as
			| {
					encryptedData: string;
					encryptionIv: string;
					encryptionAlgorithm: string;
			  }
			| undefined;
		expect(payload).toBeDefined();
		const expectedBody = JSON.stringify({
			category: "login",
			encryptedData: payload?.encryptedData,
			encryptionIv: payload?.encryptionIv,
			encryptionAlgorithm: payload?.encryptionAlgorithm,
		});
		expect(originalRequest).toEqual({
			path: `/api/v1/vaults/${vaultId}/items/${itemId}`,
			operationId,
			body: expectedBody,
		});
		const originalOutcome = await readFile(createNetwork.createReply, "utf8");
		expect(JSON.parse(originalOutcome)).toMatchObject({
			kind: "create_item",
			operationId,
			result: { status: "applied", itemId },
		});

		// Closing this dedicated Page is the old JavaScript owner-loss boundary. Its queue
		// cannot acknowledge or persist a retry after the held response becomes unreachable.
		await source.dispose();
		await legacy.close();
		await selectNetworkMode(
			createNetwork.control,
			createNetwork.acknowledgement,
			"online",
		);
		await writeFile(
			credentials,
			JSON.stringify({
				password: user.password,
				accountId: before.accountId,
				userId: before.userId,
				vaultId,
				itemId,
				operationId,
				sourceCommandId,
				attemptId,
				itemTitle,
				originalRequestBody: originalRequest?.body,
				originalOutcome,
				storeJson: Buffer.from(before.storeJson).toString("base64"),
				syncStoreJson: Buffer.from(before.syncStoreJson).toString("base64"),
				protectedEntry: Buffer.from(before.protectedEntry).toString("base64"),
			}),
			{ mode: 0o600 },
		);
		const { stdout, stderr } = await execute(
			"cargo",
			[
				"test",
				"--manifest-path",
				"apps/desktop/src-tauri/Cargo.toml",
				"--lib",
				"runtime_host::profile_source::tests::actual_admitted_create_reconciles_retained_server_outcome",
				"--",
				"--ignored",
				"--exact",
				"--nocapture",
				"--test-threads=1",
			],
			{
				cwd: repository,
				env: {
					...process.env,
					BITTERY_NATIVE_CREATE_LOSS_CREDENTIALS: credentials,
				},
				timeout: 360_000,
			},
		);
		expect(stdout).toContain("1 passed; 0 failed");
		expect(stdout).toContain(
			"runtime_host::profile_source::tests::actual_admitted_create_reconciles_retained_server_outcome ... ok",
		);
		expect(stderr).toContain(
			"Actual admitted legacy Create reconciled the original retained Server outcome without reminting identity",
		);
		expect(createNetwork.createRequests).toHaveLength(2);
		expect(createNetwork.createRequests[1]).toEqual(originalRequest);
		expect(createNetwork.createResponses).toHaveLength(2);
		expect(createNetwork.createResponses[1]).toEqual(
			createNetwork.createResponses[0],
		);
		expect(createNetwork.createResponses[0]?.body).toBe(originalOutcome);
		expect(createNetwork.createOutcomeLookups).toHaveLength(1);
		expect(createNetwork.createOutcomeLookups[0]).toMatchObject({
			path: `/api/v1/operations/${operationId}`,
			status: 200,
		});
		expect(
			JSON.parse(createNetwork.createOutcomeLookups[0]?.body ?? "null"),
		).toEqual(JSON.parse(originalOutcome));
		accepted = true;
	} finally {
		if (legacy && !legacy.isClosed())
			await legacy.close().catch(() => undefined);
		if (!fixtureAccount && signupAttempted && user) {
			try {
				fixtureAccount = await captureFixtureAccount(page, user.email);
			} catch {
				/* The exact fresh Account was not observable, so deletion stays unproved. */
			}
		}
		let userDeletionProven = false;
		if (fixtureAccount) {
			try {
				userDeletionProven = await deleteFixtureUser(page, fixtureAccount);
			} catch {
				/* Preserve the restricted fixture after a failed scoped cleanup. */
			}
		}
		const proxyClosed = network
			? await network.close().then(
					() => true,
					() => false,
				)
			: true;
		cleanupFailed = !userDeletionProven || !proxyClosed;
		if (accepted && !cleanupFailed && directory)
			await rm(directory, { recursive: true, force: true });
		else if (directory)
			console.error(
				`Native lost-Create evidence retained with restricted permissions for scoped cleanup: ${directory}`,
			);
	}
	expect(cleanupFailed, "Native lost-Create fixture cleanup").toBe(false);
});
