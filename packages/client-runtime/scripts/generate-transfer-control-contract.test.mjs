import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import * as validators from "../generated/transfer-control/validator.js";
import {
	validateAttachmentUploadSourceAnswer,
	validateAttachmentUploadSourceControl,
	validateTransferControlRequest,
	validateTransferControlResponse,
} from "../generated/transfer-control/validator.js";

const run = promisify(execFile);

test("generated transfer control artifacts match the Rust contract", async () => {
	await run(
		"node",
		["./scripts/generate-transfer-control-contract.mjs", "--check"],
		{
			cwd: new URL("..", import.meta.url),
		},
	);
});

test("generated Attachment Upload source control and answers stay closed", async () => {
	const fixture = JSON.parse(
		await readFile(
			new URL("../generated/transfer-control/fixture.json", import.meta.url),
			"utf8",
		),
	);
	for (const control of fixture.attachmentUploadSourceControls)
		assert.equal(validateAttachmentUploadSourceControl(control), true);
	for (const answer of fixture.attachmentUploadSourceAnswers)
		assert.equal(validateAttachmentUploadSourceAnswer(answer), true);
	assert.equal(
		validateAttachmentUploadSourceControl({
			type: "read",
			capabilityId: "source-1",
			maxBytes: 262144,
			extra: true,
		}),
		false,
	);
	assert.equal(
		validateAttachmentUploadSourceAnswer({ type: "futureAnswer" }),
		false,
	);
});

test("generated transfer control stays closed and keeps ciphertext binary", async () => {
	const fixture = JSON.parse(
		await readFile(
			new URL("../generated/transfer-control/fixture.json", import.meta.url),
			"utf8",
		),
	);
	for (const step of fixture.steps) {
		assert.equal(validateTransferControlRequest(step.request), true);
		assert.equal(validateTransferControlResponse(step.response), true);
	}
	assert.equal(JSON.stringify(fixture).includes('"bytes"'), false);
	assert.equal(
		validateTransferControlRequest({ type: "futureTransfer", bytes: [1] }),
		false,
	);
	assert.equal(
		validateTransferControlResponse({ type: "futureResult", url: "secret" }),
		false,
	);
});

test("file claims require their Vault and selective controls are Rust defined", async () => {
	const fixture = JSON.parse(
		await readFile(
			new URL("../generated/transfer-control/fixture.json", import.meta.url),
			"utf8",
		),
	);
	const claim = fixture.attachmentUploadSourceControls.find(
		(control) => control.type === "claim",
	);
	const { vaultId: _vaultId, ...unbound } = claim;
	assert.equal(
		validateAttachmentUploadSourceControl(unbound),
		false,
		"an Item identity alone cannot bind a source to its selected Vault",
	);
	assert.equal(
		typeof validators.validateAttachmentDownloadSinkControl,
		"function",
	);
	for (const control of fixture.attachmentDownloadSinkControls)
		assert.equal(
			validators.validateAttachmentDownloadSinkControl(control),
			true,
		);
	for (const answer of fixture.attachmentDownloadSinkAnswers)
		assert.equal(validators.validateAttachmentDownloadSinkAnswer(answer), true);
	const begin = fixture.attachmentDownloadSinkControls.find(
		(control) => control.type === "begin",
	);
	const { vaultId: _sinkVaultId, ...unboundSink } = begin;
	assert.equal(
		validators.validateAttachmentDownloadSinkControl(unboundSink),
		false,
	);
	for (const validate of [
		validateAttachmentUploadSourceControl,
		validators.validateAttachmentDownloadSinkControl,
	]) {
		assert.equal(
			validate({
				type: "retireVaults",
				accountId: "account-1",
				vaultIds: ["vault-1"],
				itemIds: ["guessed-item"],
			}),
			false,
		);
		assert.equal(
			validate({
				type: "completeVaultRetirement",
				accountId: "account-1",
				vaultIds: "vault-1",
			}),
			false,
		);
	}
	assert.equal(
		validators.validateAttachmentDownloadSinkAnswer({
			type: "committed",
			bytes: [1],
		}),
		false,
	);
});
