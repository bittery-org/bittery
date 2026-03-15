import { afterEach, describe, expect, test } from "bun:test";
import { createPresignedUpload, getStoragePublicUrl } from "../storage/s3";

const originalStorageEnv = {
	BITTERY_STORAGE_ENDPOINT: process.env.BITTERY_STORAGE_ENDPOINT,
	BITTERY_STORAGE_BUCKET: process.env.BITTERY_STORAGE_BUCKET,
	BITTERY_STORAGE_ACCESS_KEY_ID: process.env.BITTERY_STORAGE_ACCESS_KEY_ID,
	BITTERY_STORAGE_SECRET_ACCESS_KEY:
		process.env.BITTERY_STORAGE_SECRET_ACCESS_KEY,
	BITTERY_STORAGE_REGION: process.env.BITTERY_STORAGE_REGION,
	BITTERY_STORAGE_CDN_URL: process.env.BITTERY_STORAGE_CDN_URL,
	BITTERY_STORAGE_PUBLIC_URL: process.env.BITTERY_STORAGE_PUBLIC_URL,
};

describe("storage public access", () => {
	afterEach(() => {
		for (const [key, value] of Object.entries(originalStorageEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("should return null public URLs for private attachment keys", () => {
		process.env.BITTERY_STORAGE_CDN_URL = "https://cdn.example.com";

		expect(getStoragePublicUrl("attachments/user/item/file.enc")).toBeNull();
		expect(getStoragePublicUrl("teams/team-id/avatar.png")).toBe(
			"https://cdn.example.com/teams/team-id/avatar.png",
		);
		expect(getStoragePublicUrl("vaults/user-id/vault-id/image.png")).toBe(
			"https://cdn.example.com/vaults/user-id/vault-id/image.png",
		);
	});

	test("createPresignedUpload should keep shape and omit publicUrl for attachments", async () => {
		process.env.BITTERY_STORAGE_ENDPOINT = "https://storage.example.com";
		process.env.BITTERY_STORAGE_BUCKET = "bittery-test";
		process.env.BITTERY_STORAGE_ACCESS_KEY_ID = "test-access-key";
		process.env.BITTERY_STORAGE_SECRET_ACCESS_KEY = "test-secret-key";
		process.env.BITTERY_STORAGE_REGION = "auto";
		process.env.BITTERY_STORAGE_CDN_URL = "https://cdn.example.com";

		const attachmentUpload = await createPresignedUpload({
			key: "attachments/user/item/file.enc",
			contentType: "application/octet-stream",
		});
		const publicUpload = await createPresignedUpload({
			key: "teams/team-id/avatar.png",
			contentType: "image/png",
		});

		expect(attachmentUpload).toEqual({
			key: "attachments/user/item/file.enc",
			uploadUrl: expect.any(String),
			publicUrl: null,
		});
		expect(publicUpload).toEqual({
			key: "teams/team-id/avatar.png",
			uploadUrl: expect.any(String),
			publicUrl: "https://cdn.example.com/teams/team-id/avatar.png",
		});
	});
});
