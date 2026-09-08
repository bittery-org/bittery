import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildWebImportGraph } from "../../scripts/web-import-graph";

test("export reaches Runtime reads and downloads without the transitional bearer client or keys", () => {
	const hook = new URL("../hooks/use-vault-export.ts", import.meta.url)
		.pathname;
	const graph = buildWebImportGraph([hook]);
	const source = readFileSync(hook, "utf8");
	expect(source).not.toContain("api.items.list");
	expect(source).not.toContain("api.auth.me");
	expect(
		graph.imports.filter(({ module }) => module.includes("attachment-crypto")),
	).toEqual([]);
	expect(source).not.toContain("vaultCrypto");
});

import { createRuntimeClient } from "@bittery/client-runtime/client";
import type {
	ItemDraft,
	ItemsProjection,
} from "@bittery/client-runtime/protocol";
import { createFakeRuntimeTransport } from "@bittery/client-runtime/testing";
import type {
	AtomicAttachmentDownloadSink,
	AttachmentDownloadSinkGrants,
} from "@bittery/client-runtime/web";
import JSZip from "jszip";
import type { VaultExportPayload } from "./export-types";
import {
	createRuntimeVaultArchive,
	type ExportProgress,
} from "./runtime-vault-export";

const accountId = "runtime-account-without-legacy-bearer";
const drafts: ItemDraft[] = [
	{
		category: "login",
		data: {
			title: "Login",
			username: "alice",
			password: "password",
			urls: ["https://example.test"],
			passwordHistory: [{ password: "old", changedAt: "2026-01-01" }],
			customFields: [
				{ id: "custom", label: "Extra", value: "kept", type: "text" },
			],
		},
	},
	{
		category: "secure-note",
		data: { title: "Note", note: "body", tags: ["tag"] },
	},
	{
		category: "credit-card",
		data: { title: "Card", cardNumber: "4111111111111111", notes: "Card note" },
	},
	{
		category: "identity",
		data: { title: "Identity", firstName: "Alice", lastName: "Example" },
	},
	{
		category: "authenticator",
		data: {
			title: "Authenticator",
			totpSecret: "JBSWY3DPEHPK3PXP",
			totpDigits: 8,
			totpAlgorithm: "SHA256",
			totpPeriod: 60,
		},
	},
];
const attachmentBytes = new Uint8Array(140_000).map((_, index) => index % 256);
async function fixture(withAttachment = false) {
	const transport = createFakeRuntimeTransport();
	const runtime = createRuntimeClient({ transport });
	const releases = [
		runtime.session().subscribe(() => {}),
		runtime.items(accountId).subscribe(() => {}),
	];
	await transport.settled();
	const publishSession = (
		access: "unlocked" | "locked" = "unlocked",
		selected = accountId,
	) => {
		transport.publish({
			type: "runtimeStatus",
			value: {
				accountId: null,
				closed: false,
				revision: "1",
				accounts: [
					{
						accountId: selected,
						access,
						failure: null,
						replicaRevision: "2",
						displayIdentity: { email: "runtime@example.test" },
					},
				],
			},
		});
		runtime.selectAccount(selected);
	};
	publishSession();
	const projection: ItemsProjection = {
		accountId,
		replicaRevision: "2",
		vaults: [
			{
				vaultId: "vault",
				name: "Runtime Vault",
				vaultType: "team",
				role: "member",
				icon: "key",
			},
		],
		items: drafts.map((data, index) => ({
			accountId,
			itemId: `item-${index}`,
			vaultId: "vault",
			data,
			favorite: index % 2 === 0,
			status: "authoritative",
			createdAt: "2026-01-01",
			updatedAt: "2026-09-01",
			attachments:
				withAttachment && index === 0
					? [
							{
								accountId,
								itemId: "item-0",
								vaultId: "vault",
								attachmentId: "attachment",
								name: "résumé.bin",
								contentType: "application/octet-stream",
								fileSize: attachmentBytes.length,
								uploadedBy: "user",
								createdAt: "2026-01-01",
							},
						]
					: [],
		})),
	};
	transport.publish({ type: "items", value: projection });
	let sink: AtomicAttachmentDownloadSink | undefined;
	const sinks: AttachmentDownloadSinkGrants = {
		grant(input) {
			expect(input.accountId).toBe(accountId);
			expect(input.attachmentId).toBe("attachment");
			sink = input.sink;
			return "opaque-download-grant";
		},
	};
	const progress: ExportProgress[] = [];
	return {
		runtime,
		transport,
		projection,
		publishSession,
		progress,
		sink: () => sink,
		export: (signal = new AbortController().signal) =>
			createRuntimeVaultArchive(
				runtime,
				sinks,
				(next) => progress.push(next),
				signal,
			),
		close: async () => {
			for (const release of releases) release();
			await runtime.close();
		},
	};
}

test("archives all categories, favorites and fields from Runtime without a bearer session", async () => {
	const f = await fixture();
	try {
		const archive = await f.export();
		const zip = await JSZip.loadAsync(await archive.arrayBuffer());
		const payload: VaultExportPayload = JSON.parse(
			await requiredEntry(zip, "export.json").async("string"),
		);
		expect(payload.items.map((item) => item.category)).toEqual([
			"login",
			"secure-note",
			"credit-card",
			"identity",
			"totp",
		]);
		expect(JSON.stringify(payload.items.map((item) => item.data))).toBe(
			JSON.stringify(drafts.map((draft) => draft.data)),
		);
		expect(payload.items.map((item) => item.favorite)).toEqual([
			true,
			false,
			true,
			false,
			true,
		]);
		expect(payload.vaults).toEqual([
			{ id: "vault", name: "Runtime Vault", type: "team", icon: "key" },
		]);
		expect(payload.exportedBy).toEqual({ email: "runtime@example.test" });
		// Display name is optional in v1 and absent from Runtime's public Account identity.
		expect("name" in payload.exportedBy).toBe(false);
		expect(payload.metadata).toEqual({ totalItems: 5, totalVaults: 1 });
		expect(f.transport.pendingRequests()).toEqual([]);
		expect(f.progress.at(-1)?.stage).toBe("completed");
	} finally {
		await f.close();
	}
});

test("includes authenticated Attachment bytes in both v1 JSON and ZIP files", async () => {
	const f = await fixture(true);
	try {
		const exporting = f.export();
		await f.transport.settled();
		expect(f.transport.pendingRequests()[0]?.request).toEqual({
			type: "downloadAttachment",
			accountId,
			attachmentId: "attachment",
			sinkCapabilityId: "opaque-download-grant",
		});
		await f.sink()?.write(attachmentBytes);
		await f.sink()?.commit();
		f.transport.answer({
			type: "succeeded",
			value: {
				type: "attachmentDownloaded",
				accountId,
				attachmentId: "attachment",
			},
		});
		const zip = await JSZip.loadAsync(await (await exporting).arrayBuffer());
		const payload = JSON.parse(
			await requiredEntry(zip, "export.json").async("string"),
		);
		expect(payload.items[0].attachments[0]).toEqual({
			filename: "résumé.bin",
			contentType: "application/octet-stream",
			data: Buffer.from(attachmentBytes).toString("base64"),
		});
		expect(
			await requiredEntry(zip, "files/item-0/résumé.bin").async("uint8array"),
		).toEqual(attachmentBytes);
		expect(f.progress.at(-1)?.processedAttachments).toBe(1);
	} finally {
		await f.close();
	}
});

test("an unauthenticated or failed Attachment never produces a completed partial archive", async () => {
	const f = await fixture(true);
	try {
		const exporting = f.export();
		const rejected = exporting.catch((error: unknown) => error);
		await f.transport.settled();
		await f.sink()?.write(attachmentBytes.subarray(0, 10));
		f.transport.answer({
			type: "failed",
			value: { code: "RETRYABLE_TRANSPORT", message: "download failed" },
		});
		expect(await rejected).toBeInstanceOf(Error);
		expect(f.progress.some((entry) => entry.stage === "completed")).toBe(false);
	} finally {
		await f.close();
	}
});

for (const access of [
	"locked",
	"missing projection",
	"failed projection",
	"missing Vault",
] as const) {
	test(`refuses ${access} instead of exporting a false empty archive`, async () => {
		const f = await fixture();
		try {
			if (access === "locked") f.publishSession("locked");
			else if (access === "missing projection")
				f.publishSession("unlocked", "different-account");
			else if (access === "failed projection") {
				f.runtime.items = () => ({
					getSnapshot: () => ({ state: "failed", code: "AUTHORITY_MISSING" }),
					subscribe: () => () => {},
				});
			} else
				f.transport.publish({
					type: "items",
					value: { ...f.projection, vaults: [] },
				});
			await expect(f.export()).rejects.toThrow();
			expect(f.progress.some((entry) => entry.stage === "completed")).toBe(
				false,
			);
		} finally {
			await f.close();
		}
	});
}

test("Lock during an Attachment download prevents publication of a stale archive", async () => {
	const f = await fixture(true);
	try {
		const exporting = f.export();
		const rejected = exporting.catch((error: unknown) => error);
		await f.transport.settled();
		f.publishSession("locked");
		await f.sink()?.write(attachmentBytes);
		await f.sink()?.commit();
		f.transport.answer({
			type: "succeeded",
			value: {
				type: "attachmentDownloaded",
				accountId,
				attachmentId: "attachment",
			},
		});
		expect(await rejected).toBeInstanceOf(Error);
		expect(f.progress.some((entry) => entry.stage === "completed")).toBe(false);
	} finally {
		await f.close();
	}
});

function requiredEntry(zip: JSZip, name: string) {
	const entry = zip.file(name);
	if (!entry) throw new Error(`Missing archive entry ${name}`);
	return entry;
}

test("a ready empty Account exports an empty archive", async () => {
	const f = await fixture();
	try {
		f.transport.publish({
			type: "items",
			value: { ...f.projection, items: [] },
		});
		const zip = await JSZip.loadAsync(await (await f.export()).arrayBuffer());
		const payload = JSON.parse(
			await requiredEntry(zip, "export.json").async("string"),
		);
		expect(payload.metadata).toEqual({ totalItems: 0, totalVaults: 0 });
		expect(payload.items).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a cancelled export publishes neither files nor completion", async () => {
	const f = await fixture(true);
	try {
		const controller = new AbortController();
		controller.abort();
		await expect(f.export(controller.signal)).rejects.toThrow();
		expect(f.transport.pendingRequests()).toEqual([]);
		expect(f.progress).toEqual([]);
	} finally {
		await f.close();
	}
});

for (const transition of ["Lock then Unlock", "Account A to B to A"] as const) {
	test(`${transition} during ZIP generation permanently cancels the old attempt`, async () => {
		const f = await fixture();
		try {
			const stages: string[] = [];
			const exporting = createRuntimeVaultArchive(
				f.runtime,
				{
					grant() {
						throw new Error("No Attachments in this fixture");
					},
				},
				(progress) => {
					stages.push(progress.stage);
					if (progress.stage !== "building-archive") return;
					if (transition === "Lock then Unlock") f.publishSession("locked");
					else f.publishSession("unlocked", "account-b");
					f.publishSession("unlocked");
				},
				new AbortController().signal,
			);
			await expect(exporting).rejects.toThrow();
			expect(stages).not.toContain("completed");
		} finally {
			await f.close();
		}
	});
}
