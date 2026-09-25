import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { expect, generateTestUser, signUp, test } from "../fixtures/auth";
import { activateTeamPlan } from "../fixtures/billing";
import { nativeCrossAccountMoveAcceptance } from "../fixtures/native-cross-account-move";
import { nativeNetwork } from "../fixtures/native-network";
import { nativeReadOnlyVault } from "../fixtures/native-read-only-vault";
import { nativeTravelPolicy } from "../fixtures/native-travel-policy";
import {
	captureFixtureAccount,
	deleteFixtureUser,
} from "../fixtures/runtime-account-cleanup";
import { createItem, createVault } from "../fixtures/vault";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../../../..");

test("native cross-Account Attachment Move survives a lost grant reply and process restart", async ({
	page,
	browser,
}) => {
	await nativeCrossAccountMoveAcceptance(page, browser);
});

// Web supplies only the existing real signup fixture and isolated Server stack. The assertions
// execute Desktop's linked native Core and OS keychain. This is not Tauri UI acceptance and is
// opt-in because ordinary Web CI must not require Desktop's native SDK and OS credential store.
test("native Runtime signs in and restores its SQLite Replica after process restart", async ({
	page,
}) => {
	await nativeFoundationAcceptance(page, false);
});

test("native Runtime consumes incoming Travel policy while retaining protected images", async ({
	page,
}) => {
	await nativeFoundationAcceptance(page, true);
});

test("native Runtime reconciles foreground Travel settings after a lost Disable reply", async ({
	page,
}) => {
	await nativeFoundationAcceptance(page, false, "after");
});

test("native Runtime requires fresh password retry after a lost Disable request", async ({
	page,
}) => {
	await nativeFoundationAcceptance(page, false, "before");
});

test("native Runtime preserves uncertainty until current Travel policy can be read", async ({
	page,
}) => {
	await nativeFoundationAcceptance(page, false, "uncertain");
});

test("native Runtime rejects a wrong Travel password before a separate correct attempt", async ({
	page,
}) => {
	await nativeFoundationAcceptance(page, false, "wrongPassword");
});

test("native Runtime reconciles lost Save and Enable requests without automatic replay", async ({
	page,
}) => {
	await nativeFoundationAcceptance(page, false, "selectionBefore");
});

test("native Runtime reconciles lost Save and Enable replies after Server commit", async ({
	page,
}) => {
	await nativeFoundationAcceptance(page, false, "selectionAfter");
});

test("native Runtime reconciles committed Travel Enable after its caller is dropped", async ({
	page,
}) => {
	await nativeFoundationAcceptance(page, false, "callerDrop");
});

test("a fresh native Runtime reconciles committed Travel Enable after process loss", async ({
	page,
}) => {
	await nativeFoundationAcceptance(page, false, "runtimeLoss");
});

async function nativeFoundationAcceptance(
	page: Page,
	incomingTravel: boolean,
	foregroundTravel?:
		| "before"
		| "after"
		| "uncertain"
		| "wrongPassword"
		| "selectionBefore"
		| "selectionAfter"
		| "callerDrop"
		| "runtimeLoss",
) {
	test.skip(
		process.env.BITTERY_NATIVE_FOUNDATION !== "1",
		"Requires the native Desktop toolchain and a usable real OS keychain",
	);
	test.setTimeout(480_000);
	const user = await signUp(page, generateTestUser());
	const fixtureAccount = await captureFixtureAccount(page, user.email);
	const directory = await mkdtemp(join(tmpdir(), "bittery-native-foundation-"));
	const credentials = join(directory, "credentials.json");
	await writeFile(
		credentials,
		JSON.stringify({
			serverUrl: fixtureAccount.serverUrl,
			email: user.email,
			password: user.password,
			secretKey: user.secretKey,
		}),
		{ mode: 0o600 },
	);
	const network = await nativeNetwork(directory);
	let policy: Awaited<ReturnType<typeof nativeTravelPolicy>> | undefined;
	let readOnlyVault: ReturnType<typeof nativeReadOnlyVault> | undefined;
	let accepted = false;
	let cleanupFailed = false;
	try {
		activateTeamPlan(user.email);
		const expectedItemTitle = `Native foundation ${Date.now()}`;
		const expectedVaultId = await createVault(page, "Native foundation");
		await createItem(page, "login", async (sheet) => {
			await sheet.locator("#title").fill(expectedItemTitle);
			await sheet.locator("#username").fill("native-fixture");
			await sheet.locator("#password").fill("Native-fixture-password-1!");
		});

		if (foregroundTravel === "wrongPassword") {
			await createVault(page, "Native Travel shared choice", { type: "team" });
			readOnlyVault = nativeReadOnlyVault(
				page,
				directory,
				user,
				captureFixtureAccount,
				deleteFixtureUser,
			);
			await readOnlyVault.prepare();
		}
		const targetVaultId = await createVault(page, "Native Move target");
		if (
			foregroundTravel === "callerDrop" ||
			foregroundTravel === "runtimeLoss"
		) {
			await createItem(page, "login", async (sheet) => {
				await sheet.locator("#title").fill("Selected Travel loss plaintext");
				await sheet.locator("#username").fill("selected-loss-fixture");
				await sheet.locator("#password").fill("Selected-loss-password-1!");
			});
		}
		if (incomingTravel)
			policy = await nativeTravelPolicy(page, directory, user);
		await writeFile(
			credentials,
			JSON.stringify({
				serverUrl: network.serverUrl,
				networkControl: network.control,
				networkAcknowledgement: network.acknowledgement,
				networkBlockedMove: network.blockedMove,
				networkDeletionTarget: network.deletionTarget,
				networkDeletionReply: network.deletionReply,
				networkTravelCommitted: network.travelCommitted,
				incomingTravel,
				foregroundTravel,
				policyRequest: policy?.request ?? "",
				policyAcknowledgement: policy?.acknowledgement ?? "",
				targetVaultId,
				email: user.email,
				password: user.password,
				secretKey: user.secretKey,
				expectedItemTitle,
				expectedVaultId,
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
				"runtime_host::native::tests::real_server_sign_in_and_authenticated_reopen",
				"--",
				"--ignored",
				"--exact",
				"--nocapture",
			],
			{
				cwd: repository,
				env: {
					...process.env,
					BITTERY_NATIVE_ACCEPTANCE_CREDENTIALS: credentials,
				},
				timeout: 360_000,
			},
		);
		// Cargo exits successfully for an unmatched filter too; acceptance must execute the test.
		expect(stdout).toContain("1 passed; 0 failed");
		expect(stdout).toContain(
			"runtime_host::native::tests::real_server_sign_in_and_authenticated_reopen ... ok",
		);
		const deletionEvidence =
			"Actual native lost DeleteVault reply reconciled after process restart; five exact accepted Item categories rejected by deleted Vault authority";
		expect(stderr).toContain(deletionEvidence);
		expect(stderr).toContain("Real native process restart acceptance passed");
		if (
			foregroundTravel === "selectionBefore" ||
			foregroundTravel === "selectionAfter"
		) {
			const afterCommit = foregroundTravel === "selectionAfter";
			const evidence = `Actual native Core Save and Enable reconciled socket loss ${afterCommit ? "after" : "before"} Server mutation without automatic mutation replay`;
			expect(stderr).toContain(evidence);
			console.info(evidence);
			expect(network.travelSelectionEvidence).toMatchObject({
				saves: 1,
				enables: 1,
				requestsPrevented: afterCommit ? 0 : 2,
				repliesLost: afterCommit ? 2 : 0,
				successfulMutations: afterCommit ? 2 : 0,
				passwordStarts: 0,
				loginFinishes: 0,
			});
			expect(
				network.travelSelectionEvidence.policySuccessfulReadsAfterLoss,
			).toBeGreaterThanOrEqual(2);
		} else if (
			foregroundTravel === "callerDrop" ||
			foregroundTravel === "runtimeLoss"
		) {
			const evidence =
				foregroundTravel === "callerDrop"
					? "Actual native caller drop after committed Enable converged through existing policy verification without replay"
					: "Actual native process loss after committed Enable reopened the same Account and retired selected authority without replay";
			expect(stderr).toContain(evidence);
			console.info(evidence);
			expect(network.travelLossEvidence).toMatchObject({
				mutations: 1,
				committedRepliesHeld: 1,
				passwordStarts: 0,
				loginFinishes: 0,
				explicitUnlockStarts: foregroundTravel === "runtimeLoss" ? 1 : 0,
				explicitUnlockFinishes: foregroundTravel === "runtimeLoss" ? 1 : 0,
			});
			expect(
				network.travelLossEvidence.policySuccessfulReads,
			).toBeGreaterThanOrEqual(1);
		} else if (foregroundTravel) {
			const evidence = {
				before:
					"Actual native Core foreground Travel required fresh password retry after a lost Disable request, retained selection and restored fresh Vault authority",
				after:
					"Actual native Core foreground Travel saved and enabled selection, reconciled a lost successful Disable reply, retained selection and restored fresh Vault authority",
				uncertain:
					"Actual native Core foreground Travel preserved uncertainty while policy reads were unavailable, then reconciled current policy without password or proof replay",
				wrongPassword:
					"Actual native Core foreground Travel rejected a wrong password without changing policy, then accepted a separate correct password without finishing login",
			}[foregroundTravel];
			expect(stderr).toContain(evidence);
			console.info(evidence);
			const secondPassword =
				foregroundTravel === "before" || foregroundTravel === "wrongPassword";
			expect(network.travelDisableEvidence).toMatchObject({
				attempts: secondPassword ? 2 : 1,
				repliesLost:
					foregroundTravel === "after" || foregroundTravel === "uncertain"
						? 1
						: 0,
				requestsPrevented: foregroundTravel === "before" ? 1 : 0,
				successfulReplies: 1,
				deniedReplies: foregroundTravel === "wrongPassword" ? 1 : 0,
				passwordStarts: secondPassword ? 2 : 1,
				loginFinishes: 0,
			});
			if (foregroundTravel === "wrongPassword") {
				expect(stderr).toContain(
					"Actual native Core and Server saved all-visible and empty Travel selections; empty enable and over100 selection were refused",
				);
				expect(
					network.travelDisableEvidence.policySuccessfulReadsAfterDenial,
				).toBeGreaterThanOrEqual(1);
				expect(network.travelDisableEvidence.policyReadsAfterLoss).toBe(0);
			} else {
				expect(
					network.travelDisableEvidence.policyReadsAfterLoss,
				).toBeGreaterThanOrEqual(1);
				expect(
					network.travelDisableEvidence.policySuccessfulReadsAfterLoss,
				).toBeGreaterThanOrEqual(1);
			}
			if (foregroundTravel === "uncertain")
				expect(
					network.travelDisableEvidence.policyReadsPrevented,
				).toBeGreaterThanOrEqual(1);
			else expect(network.travelDisableEvidence.policyReadsPrevented).toBe(0);
		}
		console.info(deletionEvidence);
		const protectedImageEvidence =
			"Actual native protected Create image survived locked recovery and process restart, uploaded original bytes, and completed exact terminal cleanup";
		expect(stderr).toContain(protectedImageEvidence);
		console.info(protectedImageEvidence);
		const protectedUpdateEvidence =
			"Actual native offline protected Update preserved original intent through recovery and restart, uploaded exact PNG bytes, and reconciled current Vault authority";
		expect(stderr).toContain(protectedUpdateEvidence);
		console.info(protectedUpdateEvidence);
		const hiddenEvidence =
			"Actual native incoming hidden Vault policy erased authority, fenced image access, and retained exact ciphertext with zero signed uploads before proof-backed restoration";
		if (incomingTravel) {
			expect(stderr).toContain(hiddenEvidence);
			console.info(hiddenEvidence);
			expect(policy?.actions).toEqual(["enable", "disable"]);
		}
		expect(network.refused).toBeGreaterThan(0);
		expect(network.blockedMoves).toBeGreaterThan(0);
		expect(network.lostDeletions).toBe(1);
		const lost = JSON.parse(await readFile(network.deletionReply, "utf8"));
		expect(lost.kind).toBe("delete_vault");
		expect(lost.result.status).toBe("applied");
		expect(network.deletionRequests.length).toBeGreaterThanOrEqual(2);
		for (const attempt of network.deletionRequests)
			expect(attempt).toEqual({
				operationId: lost.operationId,
				vaultId: lost.result.vaultId,
				body: "{}",
			});
		accepted = true;
	} finally {
		if (!accepted)
			console.error(
				"Native bounded Sync diagnostics:",
				JSON.stringify(network.syncDiagnostics),
			);
		let userDeletionProven = false;
		try {
			const memberDeleted = (await readOnlyVault?.close()) ?? true;
			// A surviving invited User keeps its credentials and original team owner available
			// for scoped recovery; deletion of the native fixture follows proven member cleanup.
			if (memberDeleted)
				userDeletionProven = await deleteFixtureUser(page, fixtureAccount);
		} catch {
			/* Retain evidence; original acceptance failure stays authoritative. */
		}
		if (userDeletionProven)
			console.info(
				"Native foundation scoped Server User deletion proved through public Runtime and actual HTTP200",
			);
		else
			console.error(
				"Native foundation scoped Server User deletion was not proved",
			);

		const cleanup = await Promise.allSettled([
			network.close(),
			policy?.close(userDeletionProven),
		]);
		cleanupFailed =
			!userDeletionProven ||
			cleanup.some((result) => result.status === "rejected");
		if (accepted && !cleanupFailed)
			await rm(directory, { recursive: true, force: true });
		else
			console.error(
				`Native foundation acceptance credentials retained with restricted permissions for scoped cleanup: ${directory}`,
			);
	}
	expect(cleanupFailed, "Native foundation fixture cleanup").toBe(false);
}

test("native executable transfers two real Accounts and preserves Desktop lock authority", async ({
	page,
	browser,
}) => {
	test.skip(
		process.env.BITTERY_NATIVE_SOURCE_ACCEPTANCE !== "1",
		"Requires the native Desktop toolchain, actual native executable and usable real OS keychain",
	);
	test.setTimeout(480_000);
	const directory = await mkdtemp(join(tmpdir(), "bittery-native-source-"));
	const network = await nativeNetwork(directory);
	const credentials = join(directory, "credentials.json");
	const accounts: {
		email: string;
		password: string;
		secretKey: string;
		expectedItemTitle: string;
		hiddenVaultId: string;
	}[] = [];
	let second: Awaited<ReturnType<typeof browser.newPage>> | undefined;
	let accepted = false;
	const save = () =>
		writeFile(
			credentials,
			JSON.stringify({
				serverUrl: network.serverUrl,
				accounts,
				networkControl: network.control,
				networkAcknowledgement: network.acknowledgement,
				networkBlockedMove: network.blockedMove,
			}),
			{ mode: 0o600 },
		);
	try {
		const firstUser = await signUp(page, generateTestUser());
		activateTeamPlan(firstUser.email);
		const firstTitle = `Native source first ${Date.now()}`;
		const firstAccount = {
			email: firstUser.email,
			password: firstUser.password,
			secretKey: firstUser.secretKey,
			expectedItemTitle: firstTitle,
			hiddenVaultId: "",
		};
		accounts.push(firstAccount);
		await save();
		await createVault(page, "Native source first");
		await createItem(page, "login", async (sheet) => {
			await sheet.locator("#title").fill(firstTitle);
			await sheet.locator("#username").fill("first-native-source");
			await sheet
				.locator("#password")
				.fill("Native-source-fixture-password-1!");
		});
		firstAccount.hiddenVaultId = await createNativeRestrictedVault(
			page,
			"first",
		);
		await save();
		second = await browser.newPage({ baseURL: new URL(page.url()).origin });
		const secondUser = await signUp(second, generateTestUser());
		activateTeamPlan(secondUser.email);
		const secondTitle = `Native source second ${Date.now()}`;
		const secondAccount = {
			email: secondUser.email,
			password: secondUser.password,
			secretKey: secondUser.secretKey,
			expectedItemTitle: secondTitle,
			hiddenVaultId: "",
		};
		accounts.push(secondAccount);
		await save();
		await createVault(second, "Native source second");
		await createItem(second, "login", async (sheet) => {
			await sheet.locator("#title").fill(secondTitle);
			await sheet.locator("#username").fill("second-native-source");
			await sheet
				.locator("#password")
				.fill("Native-source-fixture-password-2!");
		});
		secondAccount.hiddenVaultId = await createNativeRestrictedVault(
			second,
			"second",
		);
		await save();
		await execute(
			"cargo",
			[
				"build",
				"--manifest-path",
				"apps/desktop/src-tauri/Cargo.toml",
				"--bin",
				"bittery-native-host",
			],
			{ cwd: repository, timeout: 240_000 },
		);
		const { stdout, stderr } = await execute(
			"cargo",
			[
				"test",
				"--manifest-path",
				"apps/desktop/src-tauri/Cargo.toml",
				"--lib",
				"runtime_host::native_source_transport::process_tests::real_native_binary_source_ports",
				"--",
				"--ignored",
				"--exact",
				"--nocapture",
			],
			{
				cwd: repository,
				env: {
					...process.env,
					BITTERY_NATIVE_SOURCE_CREDENTIALS: credentials,
					BITTERY_NATIVE_HOST_ACCEPTANCE_BINARY: join(
						repository,
						"apps/desktop/src-tauri/target/debug/bittery-native-host",
					),
				},
				timeout: 240_000,
			},
		);
		expect(stdout).toContain("1 passed; 0 failed");
		expect(stdout).toContain(
			"runtime_host::native_source_transport::process_tests::real_native_binary_source_ports ... ok",
		);
		expect(stderr).toContain(
			"Actual native binary exported keys for two real Server Accounts",
		);
		expect(stderr).toContain(
			"Actual native binary Travel restriction and acknowledgement preserved unrelated Vault and Account access; only fresh transfer restored hidden authority",
		);
		expect(stderr).toContain(
			"Actual native binary Travel preserved the consumer's pending Move request bytes through hide and ACK; original accepted operation converged after fresh restoration",
		);
		expect(stderr).toContain(
			"Actual native binary independently revalidated hidden authority after explicit local unlock; unrelated Vault and Account reads remained available",
		);
		const processes = stderr.match(
			/Observed actual NativeRuntime helper PID \d+; native host PIDs \d+ and \d+; independent EOF and Desktop shutdown passed/,
		);
		expect(processes).not.toBeNull();
		console.info(processes?.[0]);
		accepted = true;
	} finally {
		await second?.close();
		console.info(
			"Actual native authentication HTTP responses:",
			network.authenticationResponses,
		);
		await network.close();
		if (accepted) await rm(directory, { recursive: true, force: true });
		else
			console.error(
				`Native source acceptance credentials retained with restricted permissions for scoped cleanup: ${directory}`,
			);
	}
});

async function createNativeRestrictedVault(page: Page, name: string) {
	const vaultId = await createVault(page, `Native restricted ${name}`);
	await createItem(page, "login", async (sheet) => {
		await sheet.locator("#title").fill(`Restricted native Item ${name}`);
		await sheet.locator("#username").fill("restricted-native-source");
		await sheet.locator("#password").fill("Restricted-native-fixture-1!");
	});
	await createItem(page, "login", async (sheet) => {
		await sheet
			.locator("#title")
			.fill(`Restricted native pending Item ${name}`);
		await sheet.locator("#username").fill("pending-native-source");
		await sheet.locator("#password").fill("Pending-native-fixture-1!");
	});
	return vaultId;
}
