import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { BrowserContext, Page } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	expect,
	generateTestUser,
	readSecretKey,
	signIn,
	signUp,
	type TestUser,
	test,
} from "../fixtures/auth";
import {
	captureFixtureAccount,
	deleteFixtureUser,
} from "../fixtures/runtime-account-cleanup";
import { signUpFromInvite } from "../fixtures/team";
import { createItem, createVault } from "../fixtures/vault";

const execute = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../../..");
const fixtureDir = process.env.BITTERY_NATIVE97_PRIVATE_DIR;
const nativeBinary = process.env.BITTERY_NATIVE97_TEST_BINARY;
const hostBinary = process.env.BITTERY_NATIVE97_HOST_BINARY;
const fixtureDatabase = "bittery_test_rotation107_0ed67c8b12";
const billingRequest = "billing-request-native97-readonly-v56-second.json";
const billingReady = "billing-ready-native97-readonly-v56-second.json";
type FixtureAccount = Awaited<ReturnType<typeof captureFixtureAccount>>;

async function savePrivate(path: string, value: unknown) {
	await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

async function identity(page: Page, accountId: string) {
	return page.evaluate(async (accountId) => {
		const path = "/src/lib/crypto.ts";
		const { runtimeClient } = (await import(
			path
		)) as typeof import("../../src/lib/crypto");
		const result = await runtimeClient.readTeamPage({ accountId });
		return { userId: result.user.id, teamId: result.team?.id ?? null };
	}, accountId);
}

async function deleteSharedVault(
	page: Page,
	accountId: string,
	vaultId: string,
) {
	const answer = await page.evaluate(
		async ({ accountId, vaultId }) => {
			const path = "/src/lib/crypto.ts";
			const { runtime } = (await import(
				path
			)) as typeof import("../../src/lib/crypto");
			return JSON.parse(
				await runtime.request(
					`native97-readonly-cleanup-${crypto.randomUUID()}`,
					JSON.stringify({ type: "deleteVault", accountId, vaultId }),
				),
			) as { type: string; value: { type?: string } };
		},
		{ accountId, vaultId },
	);
	expect(answer).toMatchObject({
		type: "succeeded",
		value: { type: "vaultDeletionAccepted" },
	});
}

async function runNative(
	stage: "unshared" | "read-only",
	credentials: string,
	fixture: string,
) {
	if (!fixtureDir || !nativeBinary || !hostBinary)
		throw new Error(
			"Dedicated native97 binaries and fixture path are required",
		);
	let output = "";
	let errorOutput = "";
	let exit = 0;
	try {
		const result = await execute(
			nativeBinary,
			[
				"--exact",
				"runtime_host::native::legacy_acceptance::actual_protocol1_shared_read_only_member_reaches_old_extension",
				"--ignored",
				"--nocapture",
				"--test-threads=1",
			],
			{
				cwd: repo,
				env: {
					...process.env,
					BITTERY_NATIVE_LEGACY_CREDENTIALS: credentials,
					BITTERY_NATIVE_LEGACY_SHARED_FIXTURE: fixture,
					BITTERY_NATIVE_LEGACY_SHARED_STAGE: stage,
					BITTERY_NATIVE_HOST_ACCEPTANCE_BINARY: hostBinary,
				},
				timeout: 180_000,
				maxBuffer: 4 * 1024 * 1024,
			},
		);
		output = result.stdout;
		errorOutput = result.stderr;
	} catch (error) {
		const failed = error as Error & {
			stdout?: string;
			stderr?: string;
			code?: number;
		};
		output = failed.stdout ?? "";
		errorOutput = failed.stderr ?? "";
		exit = typeof failed.code === "number" ? failed.code : 124;
	}
	await writeFile(
		join(fixtureDir, `native-${stage}.log`),
		output + errorOutput,
		{
			mode: 0o600,
		},
	);
	await savePrivate(join(fixtureDir, `native-${stage}.exit.json`), { exit });
	if (exit !== 0 || !output.includes("1 passed; 0 failed"))
		throw new Error(
			`Native ${stage} acceptance failed; inspect the private stage log`,
		);
	const expected =
		stage === "unshared"
			? "Actual unshared recipient native snapshot and wrapped-key control passed"
			: "Actual Server-synced ReadOnly Member native host and old snapshot/key consumers passed";
	if (!(output + errorOutput).includes(expected))
		throw new Error(
			`Native ${stage} acceptance omitted its exact consumer marker`,
		);
}

async function grantCurrentReadOnly(
	page: Page,
	owner: TestUser,
	ownerAccountId: string,
	vaultId: string,
	recipient: { userId: string; email: string; fingerprint: string },
) {
	const browserModule = `/@fs${resolve(import.meta.dirname, "../fixtures/native-member-device.ts")}`;
	const granted = await page.evaluate(
		async ({ browserModule, owner, ownerAccountId, vaultId, recipient }) => {
			const device = (await import(
				browserModule
			)) as typeof import("../fixtures/native-member-device");
			return device.grantReadOnlyVault(
				owner,
				ownerAccountId,
				vaultId,
				recipient,
			);
		},
		{ browserModule, owner, ownerAccountId, vaultId, recipient },
	);
	if (!granted.ok)
		throw new Error(
			`Public ReadOnly grant failed at ${granted.phase}; HTTP ${granted.status ?? "unavailable"}`,
		);
}

test("actual Server ReadOnly recipient reaches the feature native host and unchanged decoder", async ({
	page,
	browser,
}) => {
	test.setTimeout(900_000);
	test.skip(
		process.env.BITTERY_NATIVE97_RESUME === "1",
		"Retained fixture resumes in the separate acceptance case",
	);
	test.skip(
		!fixtureDir || !nativeBinary || !hostBinary,
		"Dedicated native97 fixture and binaries are required",
	);
	if (!fixtureDir)
		throw new Error("Dedicated native97 fixture path is required");
	await mkdir(fixtureDir, { recursive: true, mode: 0o700 });
	let owner: TestUser | undefined;
	let recipient: TestUser | undefined;
	let ownerAccount: FixtureAccount | undefined;
	let recipientAccount: FixtureAccount | undefined;
	let recipientContext: BrowserContext | undefined;
	let recipientPage: Page | undefined;
	let ownerCredentialCapture: Promise<void> | undefined;
	let recipientCredentialCapture: Promise<void> | undefined;
	const wasmResponses: Promise<{
		path: string;
		status: number;
		sha256: string | null;
	}>[] = [];
	let vaultId: string | undefined;
	let itemId: string | undefined;
	let ownerDeleted = false;
	let recipientDeleted = false;
	let vaultDeleted = false;
	let accepted = false;
	const ownerRecovery = join(fixtureDir, "owner-recovery.json");
	const recipientRecovery = join(fixtureDir, "recipient-recovery.json");
	const credentials = join(fixtureDir, "recipient-credentials.json");
	const sharedFixture = join(fixtureDir, "shared-fixture.json");
	try {
		const generatedOwner = generateTestUser();
		owner = generatedOwner;
		await savePrivate(ownerRecovery, { user: owner, phase: "before-signup" });
		page.on("response", (response) => {
			const path = new URL(response.url()).pathname;
			if (path.endsWith("/index_bg.wasm")) {
				wasmResponses.push(
					response.body().then(
						(bytes) => ({
							path,
							status: response.status(),
							sha256: createHash("sha256").update(bytes).digest("hex"),
						}),
						() => ({ path, status: response.status(), sha256: null }),
					),
				);
			}
			if (
				response.request().method() === "POST" &&
				path === "/api/v1/auth/signups" &&
				response.status() === 201 &&
				!ownerCredentialCapture
			) {
				ownerCredentialCapture = (async () => {
					await savePrivate(ownerRecovery, {
						user: {
							...generatedOwner,
							secretKey: await readSecretKey(page),
						},
						phase: "signup-committed",
					});
				})();
				void ownerCredentialCapture.catch(() => undefined);
			}
		});
		owner = await signUp(page, generatedOwner, {
			plan: "team",
			beforeRuntimeSignIn: async (registeredPage) => {
				await savePrivate(ownerRecovery, {
					user: {
						...generatedOwner,
						secretKey: await readSecretKey(registeredPage),
					},
					phase: "signup-committed",
				});
			},
		});
		const build = JSON.parse(
			await readFile(join(fixtureDir, "web-wasm-build-final.json"), "utf8"),
		) as { generated: { "index_bg.wasm"?: string } };
		const expectedWasm = build.generated["index_bg.wasm"];
		const servedWasm = await Promise.all(wasmResponses);
		await savePrivate(join(fixtureDir, "web-wasm-served.json"), {
			expectedWasm,
			servedWasm,
		});
		if (
			!expectedWasm ||
			servedWasm.length === 0 ||
			servedWasm.some(
				(response) =>
					response.status !== 200 || response.sha256 !== expectedWasm,
			)
		)
			throw new Error(
				"Browser loaded a different Web WASM than the owned build",
			);
		await ownerCredentialCapture?.catch(() => undefined);
		ownerAccount = await captureFixtureAccount(page, owner.email);
		await savePrivate(ownerRecovery, {
			user: owner,
			account: ownerAccount,
			phase: "signed-in",
		});
		const ownerIdentity = await identity(page, ownerAccount.accountId);
		if (!ownerIdentity.teamId)
			throw new Error("Fresh owner Team was not published");
		const spentRequest = JSON.parse(
			await readFile(
				join(fixtureDir, "billing-request-native97-readonly-v56-first.json"),
				"utf8",
			),
		) as { email?: string; teamId?: string };
		if (
			owner.email === spentRequest.email ||
			ownerIdentity.teamId === spentRequest.teamId
		)
			throw new Error("Second fixture reused the spent owner or Team");
		await savePrivate(join(fixtureDir, billingRequest), {
			email: owner.email,
			teamId: ownerIdentity.teamId,
			fixtureDatabase,
		});
		console.info(
			"native97-readonly: fresh owner signed up; waiting for narrow owned Team billing ready marker",
		);
		await expect
			.poll(
				async () => {
					try {
						const ready = JSON.parse(
							await readFile(join(fixtureDir, billingReady), "utf8"),
						);
						return (
							ready.email === owner?.email &&
							ready.teamId === ownerIdentity.teamId &&
							ready.fixtureDatabase === fixtureDatabase
						);
					} catch {
						return false;
					}
				},
				{ timeout: 240_000 },
			)
			.toBe(true);
		console.info("native97-readonly: exact owned billing marker received");

		recipient = generateTestUser();
		await savePrivate(recipientRecovery, {
			user: recipient,
			phase: "before-invitation",
		});
		const browserModule = `/@fs${resolve(import.meta.dirname, "../fixtures/native-member-device.ts")}`;
		const invitation = await page.evaluate(
			async ({ browserModule, owner, email }) => {
				const device = (await import(
					browserModule
				)) as typeof import("../fixtures/native-member-device");
				return device.inviteTeamMember(owner, email);
			},
			{ browserModule, owner, email: recipient.email },
		);
		if (!invitation.ok)
			throw new Error(
				`Public Member invitation failed at ${invitation.phase}; HTTP ${invitation.status ?? "unavailable"}`,
			);
		const inviteUrl = new URL(
			`/invite/${encodeURIComponent(invitation.token)}`,
			page.url(),
		).href;
		recipientContext = await browser.newContext({
			baseURL: "http://localhost:3173",
		});
		recipientPage = await recipientContext.newPage();
		const committedRecipient = recipient;
		const committedRecipientPage = recipientPage;
		recipientPage.on("response", (response) => {
			if (
				response.request().method() === "POST" &&
				new URL(response.url()).pathname === "/api/v1/auth/signups" &&
				response.status() === 201 &&
				!recipientCredentialCapture
			) {
				recipientCredentialCapture = (async () => {
					await savePrivate(recipientRecovery, {
						user: {
							...committedRecipient,
							secretKey: await readSecretKey(committedRecipientPage),
						},
						phase: "signup-committed",
					});
				})();
				void recipientCredentialCapture.catch(() => undefined);
			}
		});
		recipient = await signUpFromInvite(
			recipientPage,
			inviteUrl,
			recipient,
			async (registered) => {
				await savePrivate(recipientRecovery, {
					user: registered,
					phase: "signup-committed",
				});
			},
		);
		await recipientCredentialCapture?.catch(() => undefined);
		recipientAccount = await captureFixtureAccount(
			recipientPage,
			recipient.email,
		);
		await savePrivate(recipientRecovery, {
			user: recipient,
			account: recipientAccount,
			phase: "signed-in",
		});
		const recipientIdentity = await identity(
			recipientPage,
			recipientAccount.accountId,
		);
		if (recipientIdentity.teamId !== ownerIdentity.teamId)
			throw new Error("Recipient did not join the fresh owner Team");
		const ownKey = await recipientPage.evaluate(async (accountId) => {
			const path = "/src/lib/crypto.ts";
			const { runtimeClient } = (await import(
				path
			)) as typeof import("../../src/lib/crypto");
			return runtimeClient.ownKeyFingerprint({ accountId });
		}, recipientAccount.accountId);
		if (ownKey.userId !== recipientIdentity.userId)
			throw new Error(
				"Recipient fingerprint did not match current private identity",
			);
		const vaultName = `Native ReadOnly ${nanoid(6)}`;
		vaultId = await createVault(page, vaultName, { type: "team" });
		const itemTitle = `ReadOnly private Login ${nanoid(6)}`;
		const username = `readonly-${nanoid(6)}`;
		const password = `private-${nanoid(12)}`;
		itemId = await createItem(page, "login", async (sheet) => {
			await sheet.locator("#title").fill(itemTitle);
			await sheet.locator("#username").fill(username);
			await sheet.locator("#password").fill(password);
		});
		await savePrivate(credentials, {
			serverUrl: recipientAccount.serverUrl,
			email: recipient.email,
			password: recipient.password,
			secretKey: recipient.secretKey,
		});
		await savePrivate(sharedFixture, {
			userId: recipientIdentity.userId,
			vaultId,
			vaultName,
			itemId,
			itemTitle,
			username,
			password,
		});
		await runNative("unshared", credentials, sharedFixture);

		await grantCurrentReadOnly(page, owner, ownerAccount.accountId, vaultId, {
			userId: recipientIdentity.userId,
			email: recipient.email,
			fingerprint: ownKey.fingerprint,
		});
		await runNative("read-only", credentials, sharedFixture);
		accepted = true;
	} finally {
		await ownerCredentialCapture?.catch(() => undefined);
		await recipientCredentialCapture?.catch(() => undefined);
		if (accepted && recipientAccount && recipientPage)
			recipientDeleted = await deleteFixtureUser(
				recipientPage,
				recipientAccount,
			).catch(() => false);
		if (accepted && vaultId && ownerAccount)
			vaultDeleted = await deleteSharedVault(
				page,
				ownerAccount.accountId,
				vaultId,
			).then(
				() => true,
				() => false,
			);
		if (accepted && ownerAccount && (!recipientAccount || recipientDeleted))
			ownerDeleted = await deleteFixtureUser(page, ownerAccount).catch(
				() => false,
			);
		await recipientContext?.close();
		await savePrivate(join(fixtureDir, "cleanup-receipt.json"), {
			accepted,
			ownerDeleted,
			recipientDeleted,
			vaultDeleted,
			itemCreated: Boolean(itemId),
		});
		if (ownerDeleted && recipientDeleted && vaultDeleted) {
			await Promise.all(
				[ownerRecovery, recipientRecovery, credentials, sharedFixture].map(
					(file) => unlink(file),
				),
			);
		}
	}
	expect(accepted).toBe(true);
	expect(recipientDeleted).toBe(true);
	expect(vaultDeleted).toBe(true);
	expect(ownerDeleted).toBe(true);
});

test("retained Server Member fixture reaches the native ReadOnly consumer", async ({
	page,
	browser,
}) => {
	test.setTimeout(900_000);
	test.skip(
		process.env.BITTERY_NATIVE97_RESUME !== "1",
		"Only run against the retained, billed second fixture",
	);
	if (!fixtureDir)
		throw new Error("Dedicated native97 fixture path is required");
	const ownerRecovery = join(fixtureDir, "owner-recovery.json");
	const recipientRecovery = join(fixtureDir, "recipient-recovery.json");
	const credentials = join(fixtureDir, "recipient-credentials.json");
	const sharedFixture = join(fixtureDir, "shared-fixture.json");
	const owner = (
		JSON.parse(await readFile(ownerRecovery, "utf8")) as { user: TestUser }
	).user;
	const recipient = (
		JSON.parse(await readFile(recipientRecovery, "utf8")) as {
			user: TestUser;
		}
	).user;
	const shared = JSON.parse(await readFile(sharedFixture, "utf8")) as {
		userId: string;
		vaultId: string;
		itemId: string;
	};
	const billed = JSON.parse(
		await readFile(join(fixtureDir, billingRequest), "utf8"),
	) as { email: string; teamId: string; fixtureDatabase: string };
	const ready = JSON.parse(
		await readFile(join(fixtureDir, billingReady), "utf8"),
	) as { email: string; teamId: string; fixtureDatabase: string };
	if (
		!owner.secretKey ||
		!recipient.secretKey ||
		billed.email !== owner.email ||
		billed.teamId !== ready.teamId ||
		billed.fixtureDatabase !== fixtureDatabase ||
		ready.email !== owner.email ||
		ready.fixtureDatabase !== fixtureDatabase
	)
		throw new Error(
			"Retained fixture or exact second billing proof is incomplete",
		);
	let recipientContext: BrowserContext | undefined;
	let recipientPage: Page | undefined;
	let ownerAccount: FixtureAccount | undefined;
	let recipientAccount: FixtureAccount | undefined;
	let accepted = false;
	let recipientDeleted = false;
	let vaultDeleted = false;
	let ownerDeleted = false;
	try {
		await signIn(page, owner);
		ownerAccount = await captureFixtureAccount(page, owner.email);
		const ownerIdentity = await identity(page, ownerAccount.accountId);
		if (ownerIdentity.teamId !== billed.teamId)
			throw new Error("Retained owner left the billed Team");
		recipientContext = await browser.newContext({
			baseURL: "http://localhost:3173",
		});
		recipientPage = await recipientContext.newPage();
		await signIn(recipientPage, recipient);
		recipientAccount = await captureFixtureAccount(
			recipientPage,
			recipient.email,
		);
		if (new URL(recipientAccount.serverUrl).port !== "3172")
			throw new Error("Retained recipient signed in to a different Server");
		const recipientIdentity = await identity(
			recipientPage,
			recipientAccount.accountId,
		);
		if (
			recipientIdentity.teamId !== billed.teamId ||
			recipientIdentity.userId !== shared.userId
		)
			throw new Error("Retained recipient is not the invited Server Member");
		const ownKey = await recipientPage.evaluate(async (accountId) => {
			const path = "/src/lib/crypto.ts";
			const { runtimeClient } = (await import(
				path
			)) as typeof import("../../src/lib/crypto");
			return runtimeClient.ownKeyFingerprint({ accountId });
		}, recipientAccount.accountId);
		if (ownKey.userId !== shared.userId)
			throw new Error("Retained recipient's own key changed identity");
		if (process.env.BITTERY_NATIVE97_POSITIVE_ONLY !== "1") {
			await runNative("unshared", credentials, sharedFixture);
			await grantCurrentReadOnly(
				page,
				owner,
				ownerAccount.accountId,
				shared.vaultId,
				{
					userId: shared.userId,
					email: recipient.email,
					fingerprint: ownKey.fingerprint,
				},
			);
		}
		await runNative("read-only", credentials, sharedFixture);
		accepted = true;
	} finally {
		if (accepted && recipientPage && recipientAccount)
			recipientDeleted = await deleteFixtureUser(
				recipientPage,
				recipientAccount,
			).catch(() => false);
		if (accepted && ownerAccount)
			vaultDeleted = await deleteSharedVault(
				page,
				ownerAccount.accountId,
				shared.vaultId,
			).then(
				() => true,
				() => false,
			);
		if (accepted && ownerAccount && recipientDeleted)
			ownerDeleted = await deleteFixtureUser(page, ownerAccount).catch(
				() => false,
			);
		await recipientContext?.close();
		await savePrivate(join(fixtureDir, "cleanup-resume-receipt.json"), {
			accepted,
			ownerDeleted,
			recipientDeleted,
			vaultDeleted,
			itemId: shared.itemId,
		});
		if (ownerDeleted && recipientDeleted && vaultDeleted)
			await Promise.all(
				[ownerRecovery, recipientRecovery, credentials, sharedFixture].map(
					(file) => unlink(file),
				),
			);
	}
	expect(accepted).toBe(true);
	expect(recipientDeleted).toBe(true);
	expect(vaultDeleted).toBe(true);
	expect(ownerDeleted).toBe(true);
});
