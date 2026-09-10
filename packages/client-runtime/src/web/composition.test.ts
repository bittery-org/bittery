import { describe, expect, test } from "bun:test";
import {
	commitWebAttachmentDownloadRuntimeIncarnation,
	prepareWebAttachmentDownloadRuntimeIncarnation,
	WebAttachmentDownloadSinkRegistry,
} from "../web-attachment-download-sink";
import {
	commitWebAttachmentUploadRuntimeIncarnation,
	prepareWebAttachmentUploadRuntimeIncarnation,
	WebAttachmentUploadSourceRegistry,
} from "../web-attachment-upload-source";
import { createAttachmentRuntimeIncarnationTransitions } from "./attachment-runtime-incarnation";

describe("Web Attachment Runtime scope composition", () => {
	test("does not retire Upload when Download preparation rejects before retaining the incarnation", async () => {
		const downloads = new WebAttachmentDownloadSinkRegistry();
		const uploads = new WebAttachmentUploadSourceRegistry();
		await prepareWebAttachmentDownloadRuntimeIncarnation(downloads, "occupied");
		await commitWebAttachmentDownloadRuntimeIncarnation(downloads, "occupied");
		const transition = createAttachmentRuntimeIncarnationTransitions(
			downloads,
			uploads,
		);

		await expect(transition("prepare", "rejected")).rejects.toThrow();
		expect(
			JSON.parse(
				(await uploads.invoke('{"type":"retireRuntime"}', "rejected"))
					.controlResponseJson,
			),
		).toEqual({ type: "invariantViolation" });

		expect(
			await downloads.invoke('{"type":"retireRuntime"}', undefined, "occupied"),
		).toBe('{"type":"retired"}');
		await transition("prepare", "fresh");
		await transition("commit", "fresh");
	});

	test("retires only Download when Upload preparation rejects before retaining the incarnation", async () => {
		const downloads = new WebAttachmentDownloadSinkRegistry();
		const uploads = new WebAttachmentUploadSourceRegistry();
		await prepareWebAttachmentUploadRuntimeIncarnation(uploads, "occupied");
		await commitWebAttachmentUploadRuntimeIncarnation(uploads, "occupied");
		const transition = createAttachmentRuntimeIncarnationTransitions(
			downloads,
			uploads,
		);

		await expect(transition("prepare", "rejected")).rejects.toThrow();
		expect(
			await downloads.invoke('{"type":"retireRuntime"}', undefined, "rejected"),
		).toBe('{"type":"retired"}');
		expect(
			JSON.parse(
				(await uploads.invoke('{"type":"retireRuntime"}', "rejected"))
					.controlResponseJson,
			),
		).toEqual({ type: "invariantViolation" });

		expect(
			JSON.parse(
				(await uploads.invoke('{"type":"retireRuntime"}', "occupied"))
					.controlResponseJson,
			),
		).toEqual({ type: "retired" });
		await transition("prepare", "fresh");
		await transition("commit", "fresh");
	});

	test("retires both exact scopes when Upload preparation fails with cleanup pending", async () => {
		const downloads = new WebAttachmentDownloadSinkRegistry();
		let uploadCleanupAttempts = 0;
		const uploads = new WebAttachmentUploadSourceRegistry();
		await prepareWebAttachmentUploadRuntimeIncarnation(uploads, "runtime-a");
		await commitWebAttachmentUploadRuntimeIncarnation(uploads, "runtime-a");
		uploads.grant({
			accountId: "account-a",
			itemId: "item-a",
			name: "report.txt",
			contentType: "text/plain",
			expectedBytes: 1n,
			source: {
				read: async () => null,
				close: async () => {
					uploadCleanupAttempts += 1;
					if (uploadCleanupAttempts < 3) throw new Error("held cleanup");
				},
			},
		});
		expect(
			JSON.parse(
				(await uploads.invoke('{"type":"retireRuntime"}', "runtime-a"))
					.controlResponseJson,
			),
		).toEqual({ type: "sourceFailure" });

		const transition = createAttachmentRuntimeIncarnationTransitions(
			downloads,
			uploads,
		);
		await expect(transition("prepare", "runtime-a")).rejects.toThrow();
		expect(uploadCleanupAttempts).toBe(2);

		await transition("prepare", "runtime-b");
		await transition("commit", "runtime-b");
		expect(uploadCleanupAttempts).toBe(3);
		expect(() =>
			uploads.grant({
				accountId: "account-a",
				itemId: "item-b",
				name: "fresh.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			}),
		).not.toThrow();
	});

	test("a stale commit cannot retire a newer prepared pair", async () => {
		const downloads = new WebAttachmentDownloadSinkRegistry();
		const uploads = new WebAttachmentUploadSourceRegistry();
		const transition = createAttachmentRuntimeIncarnationTransitions(
			downloads,
			uploads,
		);

		await transition("prepare", "runtime-a");
		await transition("prepare", "runtime-b");
		await expect(transition("commit", "runtime-a")).rejects.toThrow();
		await transition("commit", "runtime-b");
		expect(() =>
			uploads.grant({
				accountId: "account-a",
				itemId: "item-a",
				name: "race.txt",
				contentType: "text/plain",
				expectedBytes: 1n,
				source: { read: async () => null, close: async () => {} },
			}),
		).not.toThrow();
	});

	test("a commit racing close retires its exact pair without reopening either terminal registry", async () => {
		const downloads = new WebAttachmentDownloadSinkRegistry();
		const uploads = new WebAttachmentUploadSourceRegistry();
		const transition = createAttachmentRuntimeIncarnationTransitions(
			downloads,
			uploads,
		);

		await transition("prepare", "closing-runtime");
		const commit = transition("commit", "closing-runtime");
		downloads.beginClose();
		uploads.beginClose();

		await expect(commit).rejects.toThrow();
		await Promise.all([downloads.drainClose(), uploads.drainClose()]);
		await expect(transition("prepare", "after-close")).rejects.toThrow();
		await expect(
			prepareWebAttachmentDownloadRuntimeIncarnation(
				downloads,
				"download-after-close",
			),
		).rejects.toThrow();
		await expect(
			prepareWebAttachmentUploadRuntimeIncarnation(
				uploads,
				"upload-after-close",
			),
		).rejects.toThrow();
	});

	test("concurrent stale commit and preparation cannot escape a close fence", async () => {
		const downloads = new WebAttachmentDownloadSinkRegistry();
		const uploads = new WebAttachmentUploadSourceRegistry();
		const transition = createAttachmentRuntimeIncarnationTransitions(
			downloads,
			uploads,
		);

		await transition("prepare", "stale-runtime");
		const staleCommit = transition("commit", "stale-runtime");
		const nextPrepare = transition("prepare", "next-runtime");
		downloads.beginClose();
		uploads.beginClose();

		await expect(staleCommit).rejects.toThrow();
		await expect(nextPrepare).rejects.toThrow();
		await Promise.all([downloads.drainClose(), uploads.drainClose()]);
		await expect(transition("prepare", "later-runtime")).rejects.toThrow();
	});
});
