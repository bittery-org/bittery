import { OpfsUploadSpoolRoot } from "../src/opfs-upload-spool-internal";

declare global {
	var runOpfsUploadSpoolNetworkTest: (
		uploadUrl: string,
		contentSha256: string,
	) => Promise<{
		fileSize: number;
		scriptHeaderNames: string[];
	}>;
	var runConcurrentOpfsUploadSpoolCleanup: (
		fixtureUrl: string,
	) => Promise<void>;
}

const chromiumScope = {
	accountId: "chromium-account",
	operationId: "chromium-operation",
	attachmentId: "chromium-attachment",
	artifactId: "chromium-artifact",
	generation: "chromium-generation",
};

globalThis.runOpfsUploadSpoolNetworkTest = async (uploadUrl, contentSha256) => {
	const root = await OpfsUploadSpoolRoot.open();
	let fileSize = -1;
	let scriptHeaderNames: string[] = [];
	await root.withUploadFile(
		chromiumScope,
		6,
		3,
		(async function* () {
			yield new Uint8Array([1, 2, 3]);
			yield new Uint8Array([4, 5, 6]);
		})(),
		async (file) => {
			fileSize = file.size;
			const headers = {
				"content-type": "application/octet-stream",
				"x-amz-content-sha256": contentSha256,
			};
			scriptHeaderNames = Object.keys(headers).sort();
			const response = await fetch(uploadUrl, {
				method: "PUT",
				headers,
				body: file,
			});
			if (!response.ok)
				throw new Error(`controlled upload returned ${response.status}`);
		},
	);
	return { fileSize, scriptHeaderNames };
};

globalThis.runConcurrentOpfsUploadSpoolCleanup = async (fixtureUrl) => {
	await fetch(`${fixtureUrl}/cleanup-started`, { method: "POST" });
	const root = await OpfsUploadSpoolRoot.open();
	await root.cleanup(chromiumScope);
	await fetch(`${fixtureUrl}/cleanup-finished`, { method: "POST" });
};
