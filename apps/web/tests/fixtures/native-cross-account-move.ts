import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Browser, Page } from "@playwright/test";
import { expect, generateTestUser, readSecretKey, signUp, test } from "./auth";
import { activateTeamPlan } from "./billing";
import { nativeCrossAccountMoveNetwork } from "./native-cross-account-move-network";
import {
	captureFixtureAccount,
	deleteFixtureUser,
} from "./runtime-account-cleanup";
import { createItem, createVault } from "./vault";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../../../..");
const nativeTest =
	"runtime_host::native::cross_account_move_acceptance::real_server_attachment_move_survives_process_loss";
const nativeArguments = [
	"test",
	"--manifest-path",
	"apps/desktop/src-tauri/Cargo.toml",
	"--lib",
	nativeTest,
	"--",
	"--ignored",
	"--exact",
	"--nocapture",
];

export async function nativeCrossAccountMoveAcceptance(
	page: Page,
	browser: Browser,
) {
	test.skip(
		process.env.BITTERY_NATIVE_CROSS_ACCOUNT_MOVE !== "1",
		"Requires two real Server Users, native Desktop toolchain, OS keychain and loopback object storage",
	);
	test.setTimeout(900_000);
	const directory = await mkdtemp(join(tmpdir(), "bittery-native-cross-move-"));
	const credentials = join(directory, "credentials.json");
	const network = await nativeCrossAccountMoveNetwork(directory);
	const accounts: {
		page: Page;
		user: Awaited<ReturnType<typeof signUp>>;
		account?: Awaited<ReturnType<typeof captureFixtureAccount>>;
		vaultId: string;
		expectedItemTitle: string;
	}[] = [];
	const save = () =>
		writeFile(
			credentials,
			JSON.stringify({
				serverUrl: network.serverUrl,
				networkControl: network.control,
				networkCommitted: network.committed,
				accounts: accounts.map(({ user, vaultId, expectedItemTitle }) => ({
					...user,
					vaultId,
					expectedItemTitle,
				})),
			}),
			{ mode: 0o600 },
		);
	const readMarker = (name: string) =>
		readFile(join(directory, name), "utf8").catch(() => "");
	let native:
		| Promise<{ ok: boolean; stdout: string; stderr: string }>
		| undefined;
	let nativeRemoved = false;
	let nativeResult: { ok: boolean; stdout: string; stderr: string } | undefined;
	let allDeleted = false;
	let second: Page | undefined;
	try {
		for (const label of ["source", "target"]) {
			const selected =
				label === "source"
					? page
					: await browser.newPage({ baseURL: new URL(page.url()).origin });
			if (selected !== page) second = selected;
			const fixture = {
				page: selected,
				user: generateTestUser(),
				vaultId: "",
				expectedItemTitle: `Native cross-Account ${label} ${Date.now()}`,
				account: undefined as
					| Awaited<ReturnType<typeof captureFixtureAccount>>
					| undefined,
			};
			accounts.push(fixture);
			await save(); // Retain the exact attempted User even if signup fails after Server creation.
			try {
				fixture.user = await signUp(selected, fixture.user, {
					beforeRuntimeSignIn: async (signupPage) => {
						fixture.user.secretKey = await readSecretKey(signupPage);
						await save();
					},
				});
			} finally {
				await save();
			}
			fixture.account = await captureFixtureAccount(
				selected,
				fixture.user.email,
			);
			activateTeamPlan(fixture.user.email);
			fixture.vaultId = await createVault(
				selected,
				`Native cross-Account ${label}`,
			);
			await createItem(selected, "login", async (sheet) => {
				await sheet.locator("#title").fill(fixture.expectedItemTitle);
				await sheet.locator("#username").fill("cross-account-fixture");
				await sheet
					.locator("#password")
					.fill("Cross-account-fixture-password-1!");
			});
			await save();
		}
		native = execute("cargo", nativeArguments, {
			cwd: repository,
			env: {
				...process.env,
				BITTERY_NATIVE_CROSS_MOVE_CREDENTIALS: credentials,
			},
			timeout: 660_000,
			maxBuffer: 4 * 1024 * 1024,
		}).then(
			({ stdout, stderr }) => ({ ok: true, stdout, stderr }),
			(error: { stdout?: string; stderr?: string }) => ({
				ok: false,
				stdout: error.stdout ?? "",
				stderr: error.stderr ?? "",
			}),
		);
		await expect
			.poll(() => readMarker("native-cross-move-outcome"), {
				timeout: 540_000,
				intervals: [100],
			})
			.toMatch(/^(complete|failed)$/);
		expect(await readMarker("native-cross-move-outcome")).toBe("complete");
		const witness = JSON.parse(
			await readFile(
				join(directory, "runtime/cross-move-witness.json"),
				"utf8",
			),
		);
		const completed = JSON.parse(
			await readFile(
				join(directory, "runtime/cross-move-completed.json"),
				"utf8",
			),
		);
		const chunks = witness.artifact.chunks as {
			index: number;
			sha256: string;
			ciphertext: number[];
		}[];
		const ciphertext = Buffer.concat(
			chunks.map((chunk, index) => {
				expect(chunk.index).toBe(index);
				const bytes = Buffer.from(chunk.ciphertext);
				expect(bytes.length).toBeLessThanOrEqual(262_144);
				expect(createHash("sha256").update(bytes).digest("hex")).toBe(
					chunk.sha256,
				);
				return bytes;
			}),
		);
		expect(ciphertext.byteLength).toBe(witness.artifact.byteLength);
		expect(createHash("sha256").update(ciphertext).digest("hex")).toBe(
			witness.artifact.sha256,
		);
		expect(completed.attachments).toEqual(witness.record.attachments);
		const evidence = network.evidence;
		expect(evidence.lostReplies).toBe(1);
		expect(evidence.claimChanged).toBe(false);
		expect(evidence.durableBodies.length).toBeGreaterThanOrEqual(2);
		expect(new Set(evidence.durableBodies).size).toBe(1);
		expect(evidence.fixed?.attachmentId).toBe(witness.artifact.attachmentId);
		expect(evidence.registrations).toHaveLength(1);
		expect(evidence.registrations[0]?.status).toBe(200);
		expect(evidence.registrations[0]?.body).toBe(
			Buffer.from(completed.children[1].request.body).toString("utf8"),
		);
		const key = evidence.fixed?.key;
		if (!key)
			throw new Error(
				"Actual committed durable claim did not retain its storage key",
			);
		const objectPath = `/bittery-e2e/${key}`;
		const received = await fetch(
			`http://127.0.0.1:3030/__acceptance/object-upload?key=${encodeURIComponent(objectPath)}`,
			{ signal: AbortSignal.timeout(30_000) },
		);
		expect(received.status).toBe(200);
		expect(await received.json()).toEqual({
			attempts: 1,
			last: {
				headers: {
					"content-type": "application/octet-stream",
					"content-length": String(ciphertext.byteLength),
					"x-amz-content-sha256": witness.artifact.sha256,
					"x-amz-checksum-sha256": createHash("sha256")
						.update(ciphertext)
						.digest("base64"),
				},
				byteLength: ciphertext.byteLength,
				sha256: witness.artifact.sha256,
			},
		});
		// The loopback fixture checks payload checksums and real HEAD metadata, not AWS credentials/signatures.
		const object = await fetch(
			`http://127.0.0.1:3030/bittery-e2e/${key.split("/").map(encodeURIComponent).join("/")}`,
			{ signal: AbortSignal.timeout(30_000) },
		);
		expect(object.status).toBe(200);
		expect(Buffer.from(await object.arrayBuffer())).toEqual(ciphertext);
	} finally {
		try {
			const deletions = [];
			for (const fixture of accounts.slice().reverse()) {
				try {
					fixture.account ??= await captureFixtureAccount(
						fixture.page,
						fixture.user.email,
					);
					deletions.push(
						await deleteFixtureUser(fixture.page, fixture.account),
					);
				} catch {
					deletions.push(false);
				}
			}
			allDeleted =
				deletions.length === accounts.length && deletions.every(Boolean);
			if (native && allDeleted && accounts.length === 2) {
				await writeFile(
					join(directory, "native-cross-move-users-deleted"),
					"both-public-deletions-proved",
					{ mode: 0o600 },
				);
				nativeResult = await native;
				console.info(nativeResult.stderr);
				nativeRemoved =
					(await readMarker("native-cross-move-cleaned")) ===
					"native-accounts-removed";
				if (!nativeRemoved) {
					const cleanup = await execute("cargo", nativeArguments, {
						cwd: repository,
						env: {
							...process.env,
							BITTERY_NATIVE_CROSS_MOVE_CREDENTIALS: credentials,
							BITTERY_NATIVE_CROSS_MOVE_PHASE: "cleanup",
						},
						timeout: 90_000,
					}).then(
						({ stdout }) => stdout.includes("1 passed; 0 failed"),
						() => false,
					);
					nativeRemoved = cleanup;
				}
			}
		} finally {
			if (native && !nativeResult) nativeResult = await native;
			const closed = await Promise.allSettled([
				second?.close(),
				network.close(),
			]);
			const resourcesClosed = closed.every(
				(result) => result.status === "fulfilled",
			);
			if (allDeleted && (!native || nativeRemoved) && resourcesClosed)
				await rm(directory, { recursive: true, force: true });
			else
				console.error(
					`Protected native cross-Account storage retained until scoped cleanup is proved: ${directory}`,
				);
			expect(
				resourcesClosed,
				"Native acceptance pages and proxies must close",
			).toBe(true);
		}
		expect(
			allDeleted,
			"Every provisioned fixture User must be publicly deleted",
		).toBe(true);
		if (native)
			expect(
				nativeRemoved,
				"Native Accounts must be removed after public User deletion",
			).toBe(true);
		if (nativeResult) {
			expect(nativeResult.ok, "Actual native process history must pass").toBe(
				true,
			);
			expect(nativeResult.stderr).toContain(
				"Actual native cross-Account Attachment Move restored original sealed bytes after process loss",
			);
		}
	}
}
