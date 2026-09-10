import type { TransferControlRequest } from "../generated/transfer-control/contract";
import fixture from "../generated/transfer-control/fixture.json";
import { validateTransferControlRequest } from "../generated/transfer-control/validator.js";
import { WebBinaryTransferExecutor } from "../src/web-binary-transfer-executor";

declare global {
	var startBinaryTransferUpload: (
		transferId: string,
		uploadUrl: string,
		generation: string,
	) => Promise<void>;
	var cancelBinaryTransferUpload: (
		transferId: string,
	) => Promise<{ cancel: unknown; finish: unknown }>;
	var awaitBinaryTransferUpload: (
		transferId: string,
	) => Promise<{ finish: unknown; scriptHeaderNames: string[] }>;
	var closeBinaryTransferExecutor: () => void;
	var runForegroundAttachmentUpload: (
		accountId: string,
		attachmentId: string,
		uploadUrl: string,
	) => Promise<string>;
}

const scriptHeaders = new Map<string, string[]>();
const finishes = new Map<string, Promise<unknown>>();
const executor = new WebBinaryTransferExecutor();

function generatedRequest(
	type: TransferControlRequest["type"],
): TransferControlRequest {
	const request = fixture.steps.find(
		(step) => step.request.type === type,
	)?.request;
	if (!validateTransferControlRequest(request))
		throw new Error(`missing generated ${type} fixture`);
	return request;
}

async function invoke(request: object, bytes?: Uint8Array): Promise<unknown> {
	const result = await executor.invoke(JSON.stringify(request), bytes);
	return JSON.parse(result.controlResponseJson);
}

globalThis.startBinaryTransferUpload = async (
	transferId,
	uploadUrl,
	generation,
) => {
	const beginFixture = generatedRequest("beginUpload");
	if (beginFixture.type !== "beginUpload") throw new Error("fixture drift");
	const begin = {
		...beginFixture,
		transferId,
		generation,
		url: `${uploadUrl}?transfer=${encodeURIComponent(transferId)}`,
	};
	scriptHeaders.set(transferId, begin.headers.map(({ name }) => name).sort());
	await invoke(begin);
	const chunkFixture = generatedRequest("writeUploadChunk");
	if (chunkFixture.type !== "writeUploadChunk")
		throw new Error("fixture drift");
	await invoke({ ...chunkFixture, transferId }, new Uint8Array([1, 2, 3]));
	const finishFixture = generatedRequest("finishUpload");
	if (finishFixture.type !== "finishUpload") throw new Error("fixture drift");
	finishes.set(transferId, invoke({ ...finishFixture, transferId }));
};

globalThis.cancelBinaryTransferUpload = async (transferId) => {
	const finish = finishes.get(transferId);
	if (finish === undefined) throw new Error("upload was not started");
	const cancel = await invoke({ type: "cancelTransfer", transferId });
	return { cancel, finish: await finish };
};

globalThis.awaitBinaryTransferUpload = async (transferId) => {
	const finish = finishes.get(transferId);
	if (finish === undefined) throw new Error("upload was not started");
	return {
		finish: await finish,
		scriptHeaderNames: scriptHeaders.get(transferId) ?? [],
	};
};

globalThis.closeBinaryTransferExecutor = () => executor.close();

globalThis.runForegroundAttachmentUpload = async (
	accountId,
	attachmentId,
	uploadUrl,
) => {
	const transferId = executor.beginForegroundUpload(
		accountId,
		attachmentId,
		`${uploadUrl}?transfer=foreground`,
		3,
	);
	await executor.writeForegroundUpload(transferId, new Uint8Array([4, 5, 6]));
	return executor.finishForegroundUpload(
		transferId,
		"787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472",
	);
};
