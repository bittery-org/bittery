import { describe, expect, test } from "bun:test";
import { createWebClientRuntime } from "./composition";

describe("Web host binary capability grants", () => {
	test("exposes only host-owned source capabilities while lifecycle stays inside composition", async () => {
		const composition = createWebClientRuntime({
			createWorker: () => {
				throw new Error(
					"the lazy Worker must not start for interface inspection",
				);
			},
		});

		expect(Object.keys(composition.attachmentUploadSources)).toEqual(["grant"]);
		expect("invoke" in composition.attachmentUploadSources).toBe(false);
		expect("beginClose" in composition.attachmentUploadSources).toBe(false);
		expect("drainClose" in composition.attachmentUploadSources).toBe(false);
		expect(Object.keys(composition.attachmentDownloadSinks)).toEqual(["grant"]);
		expect("invoke" in composition.attachmentDownloadSinks).toBe(false);
		expect("beginClose" in composition.attachmentDownloadSinks).toBe(false);
		expect(Object.keys(composition.vaultImageSources)).toEqual([
			"grant",
			"discard",
		]);
		expect("invoke" in composition.vaultImageSources).toBe(false);
		expect("retireAccount" in composition.vaultImageSources).toBe(false);
		expect("reactivateAccount" in composition.vaultImageSources).toBe(false);
		expect("drainClose" in composition.vaultImageSources).toBe(false);

		await composition.close();
	});
});
