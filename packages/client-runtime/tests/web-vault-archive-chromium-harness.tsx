import { createRoot } from "react-dom/client";
import JSZip from "../../../apps/web/node_modules/jszip";
import { useVaultExport } from "../../../apps/web/src/hooks/use-vault-export";
import { validateReplicaPersistenceResponse } from "../generated/persistence/validator.js";
import { IndexedDbReplicaExecutor } from "../src/indexeddb-executor";
import { RuntimeProvider } from "../src/react";
import {
	archiveGateReached,
	attachmentDiscards,
	cleanupAcknowledgements,
	composition,
	exportCaptures,
	holdArchive,
	loseArchiveOwner,
	ownerLost,
	pauseArchive,
	provisionalAttachmentBytes,
	releaseArchive,
	retirements,
	runtimeClient,
	workersCreated,
} from "./web-vault-archive-composition";

let actions:
	| Pick<
			ReturnType<typeof useVaultExport>,
			"startExport" | "downloadArchive" | "reset"
	  >
	| undefined;
let archiveError: string | null = null;
let urlsCreated = 0;
let urlsRevoked = 0;
let activeTask: Promise<unknown> | undefined;
let activeTaskSettled = false;
let retirementTask: Promise<unknown> | undefined;
let retirementSettled = false;
let retirementResult: unknown;
const liveUrls = new Set<string>();
const createObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (value) => {
	urlsCreated += 1;
	const url = createObjectURL(value);
	liveUrls.add(url);
	return url;
};
const revokeObjectURL = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => {
	urlsRevoked += 1;
	liveUrls.delete(url);
	return revokeObjectURL(url);
};
// Hold the real ZIP result before the builder resumes. The app still owns and cleans it.
const generateAsync = JSZip.prototype.generateAsync;
JSZip.prototype.generateAsync = async function (...args) {
	const result = await generateAsync.apply(this, args);
	await pauseArchive("zip");
	return result;
};
function Archive() {
	const state = useVaultExport();
	archiveError = state.error;
	actions = {
		startExport: state.startExport,
		downloadArchive: state.downloadArchive,
		reset: state.reset,
	};
	return (
		<>
			<span id="archive-stage">{state.progress.stage}</span>
			<button
				type="button"
				id="archive-download"
				disabled={!state.archiveReady}
				onClick={state.downloadArchive}
			>
				Download
			</button>
		</>
	);
}
const container = document.createElement("main");
document.body.append(container);
const root = createRoot(container);
root.render(
	<RuntimeProvider client={runtimeClient}>
		<Archive />
	</RuntimeProvider>,
);
const paint = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function initialize() {
	const store = runtimeClient.items("account-1");
	await new Promise<void>((resolve, reject) => {
		let release = () => {};
		release = store.subscribe(() => {
			const value = store.getSnapshot();
			if (value.state === "ready") {
				release();
				resolve();
			}
			if (value.state === "failed") {
				release();
				reject(new Error(value.code));
			}
		});
	});
	runtimeClient.selectAccount("account-1");
	await paint();
	const snapshot = store.getSnapshot();
	if (snapshot.state !== "ready" || snapshot.value.items.length !== 1)
		throw new Error("Missing actual archive source");
	return {
		workersCreated,
		selectedVaultId: snapshot.value.items[0].vaultId,
		vaultIds: snapshot.value.vaults.map((vault) => vault.vaultId),
	};
}
async function uploadAttachment() {
	const bytes = new Uint8Array(140_000).map((_, index) => index % 256);
	let offset = 0;
	const sources = composition.attachmentUploadSources;
	const sourceCapabilityId = sources.grant({
		scope: sources.captureScope("account-1", "vault-1"),
		accountId: "account-1",
		vaultId: "vault-1",
		itemId: "item-existing",
		name: "résumé.bin",
		contentType: "application/octet-stream",
		expectedBytes: BigInt(bytes.length),
		source: {
			async read(maxBytes) {
				if (offset === bytes.length) return null;
				const chunk = bytes.slice(offset, offset + maxBytes);
				offset += chunk.length;
				return chunk;
			},
			async close() {
				bytes.fill(0);
			},
		},
	});
	const result = JSON.parse(
		await composition.runtime.request(
			"archive-upload",
			JSON.stringify({
				type: "uploadAttachment",
				accountId: "account-1",
				itemId: "item-existing",
				sourceCapabilityId,
				name: "résumé.bin",
				contentType: "application/octet-stream",
				fileSize: "140000",
			}),
		),
	);
	if (result.type !== "succeeded")
		throw new Error(`Archive Attachment setup: ${JSON.stringify(result)}`);
	await paint();
	const items = runtimeClient.items("account-1").getSnapshot();
	if (items.state !== "ready" || items.value.items[0].attachments?.length !== 1)
		throw new Error("Archive Attachment authority is missing");
}
function snapshot() {
	return {
		ready: !(
			document.querySelector<HTMLButtonElement>("#archive-download")
				?.disabled ?? true
		),
		stage: document.querySelector("#archive-stage")?.textContent,
	};
}
async function start() {
	if (!actions) throw new Error("Archive hook is not mounted");
	await actions.startExport();
	await paint();
	if (archiveError) throw new Error(`Actual archive startup: ${archiveError}`);
	return snapshot();
}
async function refresh() {
	const result = JSON.parse(
		await composition.runtime.request(
			"archive-policy-refresh",
			JSON.stringify({ type: "refreshTravelMode", accountId: "account-1" }),
		),
	);
	await paint();
	const items = runtimeClient.items("account-1").getSnapshot();
	const session = runtimeClient.session().getSnapshot();
	return {
		result,
		accountUnlocked: session.state === "unlocked",
		items: items.state === "ready" ? items.value.items.length : null,
		vaultIds:
			items.state === "ready"
				? items.value.vaults.map((vault) => vault.vaultId)
				: [],
		ready: snapshot().ready,
	};
}
async function tryDownload() {
	const before = urlsCreated;
	await actions?.downloadArchive();
	await paint();
	return { outputs: urlsCreated - before };
}
async function close() {
	releaseArchive();
	root.unmount();
	actions = undefined;
	try {
		await composition.close();
	} catch (failure) {
		if (!ownerLost || !String(failure).includes("joined Export owner loss"))
			throw failure;
	}
}
async function captureEncryptedAuthority() {
	const executor = new IndexedDbReplicaExecutor();
	const loaded: unknown = JSON.parse(
		await executor.invoke(
			JSON.stringify({ type: "load", accountId: "account-1" }),
		),
	);
	if (!validateReplicaPersistenceResponse(loaded) || loaded.type !== "loaded")
		throw new Error("Missing fixture authority");
	return {
		vaults: loaded.rows
			.filter((row) => row.store === "authorityVaults")
			.map((row) => JSON.parse(row.payloadJson)),
		items: loaded.rows
			.filter((row) => row.store === "authorityItems")
			.map((row) => JSON.parse(row.payloadJson)),
	};
}
function queueAction(kind: "start" | "download") {
	activeTaskSettled = false;
	activeTask = (
		kind === "start" ? start() : actions?.downloadArchive()
	)?.finally(() => {
		activeTaskSettled = true;
	});
	void activeTask?.catch(() => undefined);
}
function queueRetirement(kind: "hide" | "close" | "loss" | "reset") {
	retirementSettled = false;
	retirementTask = (
		kind === "hide"
			? refresh()
			: kind === "close"
				? composition.close()
				: kind === "loss"
					? Promise.resolve(loseArchiveOwner())
					: Promise.resolve(actions?.reset())
	).then((result) => {
		retirementResult = result;
		retirementSettled = true;
	});
	void retirementTask.catch(() => undefined);
}
Object.assign(globalThis, {
	initializeVaultArchive: initialize,
	vaultArchiveSnapshot: snapshot,
	vaultArchiveCaptureCount: () => exportCaptures,
	vaultArchiveItems: () => runtimeClient.items("account-1").getSnapshot(),
	startVaultArchive: start,
	refreshVaultArchivePolicy: refresh,
	tryVaultArchiveDownload: tryDownload,
	closeVaultArchive: close,
	uploadVaultArchiveAttachment: uploadAttachment,
	captureVaultArchiveEncryptedAuthority: captureEncryptedAuthority,
	holdVaultArchive: holdArchive,
	releaseVaultArchive: releaseArchive,
	queueVaultArchiveAction: queueAction,
	queueVaultArchiveRetirement: queueRetirement,
	settleVaultArchive: async () => {
		await activeTask;
		await retirementTask;
		await paint();
	},
	vaultArchiveLifetime: () => ({
		provisionalAttachmentBytes,
		attachmentDiscards,
		...snapshot(),
		gateReached: archiveGateReached(),
		cleanupAcknowledgements,
		retirements,
		activeTaskSettled,
		retirementSettled,
		retirementResult,
		urlsCreated,
		urlsRevoked,
		liveUrls: liveUrls.size,
	}),
});
