import { describe, expect, test } from "bun:test";
import { RuntimeRequestError } from "@bittery/client-runtime/client";
import {
	createAttachmentDownloadBuffer,
	createFileAttachmentUploadSource,
	getRuntimeAttachmentUploadErrorCode,
} from "./use-runtime-item-attachments";

describe("Web Runtime Attachment host adapters", () => {
	test("streams a File through the reusable source-grant contract", async () => {
		const source = createFileAttachmentUploadSource(
			new File([new Uint8Array([1, 2, 3, 4, 5])], "report.bin"),
		);

		expect([...((await source.read(2)) ?? [])]).toEqual([1, 2]);
		expect([...((await source.read(2)) ?? [])]).toEqual([3, 4]);
		expect([...((await source.read(2)) ?? [])]).toEqual([5]);
		expect(await source.read(2)).toBeNull();
		await source.close();
		await expect(source.read(2)).rejects.toThrow();
	});

	test("publishes Download bytes only after an exact commit and wipes a discard", async () => {
		const sink = createAttachmentDownloadBuffer(3);
		await sink.write(new Uint8Array([1, 2]));
		expect(() => sink.take()).toThrow();
		await expect(sink.commit()).rejects.toThrow();
		await sink.write(new Uint8Array([3]));
		await sink.commit();
		expect([...sink.take()]).toEqual([1, 2, 3]);

		const discarded = createAttachmentDownloadBuffer(2);
		const retained = new Uint8Array([9]);
		await discarded.write(retained);
		await discarded.discard();
		expect(() => discarded.take()).toThrow();
	});

	test("maps only closed Runtime Upload failures into existing UI categories", () => {
		expect(
			getRuntimeAttachmentUploadErrorCode(
				new RuntimeRequestError("SIZE_REJECTED", "private"),
			),
		).toBe("file-too-large");
		expect(
			getRuntimeAttachmentUploadErrorCode(
				new RuntimeRequestError("QUOTA_EXCEEDED", "private"),
			),
		).toBe("storage-limit-reached");
		expect(getRuntimeAttachmentUploadErrorCode(new Error("quota"))).toBe(
			"unknown",
		);
	});
});
