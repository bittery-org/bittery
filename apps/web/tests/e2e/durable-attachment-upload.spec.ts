import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, generateTestUser, signUp, test } from "../fixtures/auth";
import { activateTeamPlan } from "../fixtures/billing";
import { durableAttachmentDevice } from "../fixtures/durable-attachment-device";
import { runE2eSql, sqlString } from "../fixtures/e2e-database";
import {
	captureFixtureAccount,
	deleteFixtureUser,
} from "../fixtures/runtime-account-cleanup";
import { createItem, createVault } from "../fixtures/vault";

test("durable Attachment grant retries and renews one encrypted object through the real Server", async ({
	page,
}, testInfo) => {
	test.skip(
		testInfo.project.name !== "cloud",
		"Uses the isolated cloud billing fixture",
	);
	test.setTimeout(300_000);
	const user = await signUp(page, generateTestUser());
	const directory = await mkdtemp(join(tmpdir(), "bittery-durable-upload-"));
	await writeFile(join(directory, "credentials.json"), JSON.stringify(user), {
		mode: 0o600,
	});
	let account: Awaited<ReturnType<typeof captureFixtureAccount>> | undefined;
	let device: Awaited<ReturnType<typeof durableAttachmentDevice>> | undefined;
	let deletionProven = false;
	try {
		account = await captureFixtureAccount(page, user.email);
		activateTeamPlan(user.email);
		const vaultId = await createVault(page, "Durable upload authority");
		const itemId = await createItem(page, "login", async (sheet) => {
			await sheet.locator("#title").fill("Durable Attachment target");
			await sheet.locator("#username").fill("durable-fixture");
			await sheet.locator("#password").fill("Durable-fixture-password-1!");
		});
		const plaintext = Buffer.from(
			"Durable Attachment plaintext — exact renewal\n\0\u00ff",
			"utf8",
		);
		device = await durableAttachmentDevice(
			page,
			user,
			itemId,
			vaultId,
			Array.from(plaintext),
		);
		const prepared = await device.evaluate((fixture) => fixture.prepared);
		const ciphertext = Buffer.from(prepared.ciphertext);
		expect(ciphertext.byteLength).toBeGreaterThan(plaintext.byteLength);
		expect(createHash("sha256").update(ciphertext).digest("hex")).toBe(
			prepared.digest,
		);
		const grantPath = `${account.serverUrl}/api/v1/items/${itemId}/attachment-uploads`;
		const requestBodies: string[] = [];
		let lostCommittedReply = false;
		await page.route(grantPath, async (route) => {
			const body = route.request().postData();
			if (body === null) throw new Error("Grant request body was absent");
			requestBodies.push(body);
			if (!lostCommittedReply) {
				const response = await route.fetch();
				expect(response.status()).toBe(200);
				lostCommittedReply = true;
				await route.abort("failed");
				return;
			}
			await route.continue();
		});
		const lost = await device.evaluate((fixture) => fixture.grant());
		expect(lostCommittedReply).toBe(true);
		expect(lost.ok).toBe(false);
		const retried = await device.evaluate((fixture) => fixture.grant());
		if (!retried.ok)
			throw new Error(`Exact durable grant retry failed: ${retried.status}`);
		expect(retried.upload.attachmentId).toBe(prepared.attachmentId);
		const immutableClaim = () =>
			runE2eSql(
				`SELECT (to_jsonb(p)-'expires_at'-'next_cleanup_at')::text FROM pending_attachment_upload p WHERE attachment_id='${sqlString(prepared.attachmentId)}'`,
			);
		const originalClaim = immutableClaim();
		const upload = async (grant: typeof retried.upload) => {
			const headers = grant.uploadHeaders;
			expect(headers).toHaveLength(4);
			if (!headers) throw new Error("Durable grant omitted signed headers");
			const values = Object.fromEntries(
				headers.map(({ name, value }) => [name.toLowerCase(), value]),
			);
			expect(values).toEqual({
				"content-type": "application/octet-stream",
				"content-length": String(ciphertext.byteLength),
				"x-amz-content-sha256": prepared.digest,
				"x-amz-checksum-sha256": createHash("sha256")
					.update(ciphertext)
					.digest("base64"),
			});
			// The existing loopback S3 fixture checks payload checksum and returns real HEAD
			// metadata. It intentionally does not verify AWS credentials/signatures.
			const response = await fetch(grant.uploadUrl, {
				method: "PUT",
				headers: values,
				body: ciphertext,
				signal: AbortSignal.timeout(30_000),
			});
			expect(response.status).toBe(200);
		};
		await upload(retried.upload);
		expect(
			runE2eSql(
				`UPDATE pending_attachment_upload SET expires_at=NOW()-INTERVAL '1 second',next_cleanup_at=NOW()-INTERVAL '1 second' WHERE attachment_id='${sqlString(prepared.attachmentId)}' AND consumed_at IS NULL`,
			),
		).toBe("UPDATE 1");
		const renewed = await device.evaluate((fixture) => fixture.grant());
		if (!renewed.ok)
			throw new Error(`Exact expired grant renewal failed: ${renewed.status}`);
		expect(renewed.upload.attachmentId).toBe(prepared.attachmentId);
		expect(renewed.upload.key).toBe(retried.upload.key);
		expect(immutableClaim()).toBe(originalClaim);
		expect(requestBodies).toHaveLength(3);
		expect(requestBodies.every((body) => body === requestBodies[0])).toBe(true);
		await upload(renewed.upload);
		const registered = await device.evaluate((fixture) =>
			fixture.registerAndVerify(),
		);
		expect(registered.attachmentId).toBe(prepared.attachmentId);
		const downloaded = await fetch(registered.downloadUrl, {
			signal: AbortSignal.timeout(30_000),
		});
		expect(downloaded.status).toBe(200);
		const bytes = Buffer.from(await downloaded.arrayBuffer());
		expect(bytes.equals(ciphertext)).toBe(true);
		expect(
			await device.evaluate(
				(fixture, bytes) => fixture.verifyDownload(bytes),
				Array.from(bytes),
			),
		).toBe(true);
		const consumed = await device.evaluate((fixture) => fixture.grant());
		expect(consumed).toEqual({ ok: false, status: 409 });
		await page.unroute(grantPath);
		deletionProven = await deleteFixtureUser(page, account);
		expect(deletionProven).toBe(true);
		expect(
			runE2eSql(
				`SELECT CASE WHEN COUNT(*)=1 THEN 'retired durable claim retained' ELSE 'retired claim missing' END FROM pending_attachment_upload WHERE attachment_id='${sqlString(prepared.attachmentId)}' AND consumed_at IS NOT NULL AND next_cleanup_at IS NOT NULL AND created_by IS NULL AND item_id IS NULL AND vault_id IS NULL AND team_id IS NULL`,
			),
		).toContain("retired durable claim retained");
	} finally {
		if (!deletionProven && account)
			deletionProven = await deleteFixtureUser(page, account);
		if (deletionProven) {
			await device?.evaluate((fixture) => fixture.close(true));
			await device?.dispose();
			await rm(directory, { recursive: true });
		} else {
			console.error(
				`Durable upload fixture credentials retained for public cleanup: ${directory}`,
			);
		}
	}
	expect(deletionProven).toBe(true);
});
