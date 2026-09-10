import { OpfsUploadSpoolRoot } from "../src/opfs-upload-spool-internal";
import { WebBinaryTransferExecutor } from "../src/web-binary-transfer-executor";

declare global {
	var runOpfsUploadSpoolNetworkTest: (
		uploadUrl: string,
		contentSha256: string,
	) => Promise<{
		fileSize: number;
		scriptHeaderNames: string[];
	}>;
	var runConcurrentOpfsUploadSpoolWipe: (fixtureUrl: string) => Promise<void>;
	var runOpfsUploadSpoolTeardown: () => Promise<{
		directories: string[][];
		spooled: string[][];
		afterAccountDeletion: string[][];
		afterDeviceWipe: string[][];
		responses: string[];
	}>;
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

globalThis.runConcurrentOpfsUploadSpoolWipe = async (fixtureUrl) => {
	await fetch(`${fixtureUrl}/wipe-started`, { method: "POST" });
	const root = await OpfsUploadSpoolRoot.open();
	await root.wipeDevice();
	await fetch(`${fixtureUrl}/wipe-finished`, { method: "POST" });
};

const SPOOL_DIRECTORY = "bittery-ciphertext-upload-spool-v1";

async function spoolTree(): Promise<string[][]> {
	const root = await navigator.storage.getDirectory();
	const spool = await root.getDirectoryHandle(SPOOL_DIRECTORY, {
		create: true,
	});
	const tree: string[][] = [];
	for await (const entry of (
		spool as unknown as { values(): AsyncIterable<FileSystemHandle> }
	).values()) {
		const account = await spool.getDirectoryHandle(entry.name);
		const files: string[] = [];
		for await (const file of (
			account as unknown as { values(): AsyncIterable<FileSystemHandle> }
		).values()) {
			files.push(file.name);
		}
		tree.push([entry.name, ...files.sort()]);
	}
	return tree.sort((left, right) => left[0].localeCompare(right[0]));
}

async function spoolOrphan(directoryName: string): Promise<void> {
	const root = await navigator.storage.getDirectory();
	const spool = await root.getDirectoryHandle(SPOOL_DIRECTORY, {
		create: true,
	});
	const account = await spool.getDirectoryHandle(directoryName);
	const file = await account.getFileHandle("orphan.ciphertext", {
		create: true,
	});
	const writable = await file.createWritable();
	await writable.write(new Uint8Array([9, 9, 9]));
	await writable.close();
}

globalThis.runOpfsUploadSpoolTeardown = async () => {
	const root = await OpfsUploadSpoolRoot.open();
	const directories = new Map<string, string>();
	for (const accountId of ["teardown-a", "teardown-b"]) {
		const before = new Set((await spoolTree()).map(([name]) => name));
		await root.withUploadFile(
			{ ...chromiumScope, accountId },
			3,
			3,
			(async function* () {
				yield new Uint8Array([7, 8, 9]);
			})(),
			async () => {},
		);
		const added = (await spoolTree())
			.map(([name]) => name)
			.find((name) => !before.has(name));
		if (added === undefined) throw new Error("the spool created no directory");
		directories.set(accountId, added);
		// A crashed tab leaves ciphertext behind that no live upload owns. Teardown must take
		// it too, so the proof needs one on disk.
		await spoolOrphan(added);
	}

	const spooled = await spoolTree();
	// The production executor, with no injected spool: it opens the real OPFS root itself.
	const executor = new WebBinaryTransferExecutor();
	const responses: string[] = [];
	responses.push(
		(
			await executor.invoke(
				JSON.stringify({ type: "deleteAccount", accountId: "teardown-a" }),
			)
		).controlResponseJson,
	);
	const afterAccountDeletion = await spoolTree();
	responses.push(
		(await executor.invoke(JSON.stringify({ type: "wipeDevice" })))
			.controlResponseJson,
	);
	const afterDeviceWipe = await spoolTree();
	return {
		directories: [...directories].map(([accountId, name]) => [accountId, name]),
		spooled,
		afterAccountDeletion,
		afterDeviceWipe,
		responses,
	};
};
