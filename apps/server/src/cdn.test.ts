import { describe, expect, test } from "bun:test";
import { servePublicStorageKey } from "./cdn";

describe("servePublicStorageKey", () => {
	test("should return 404 for private attachment keys before presigning", async () => {
		let presignCalls = 0;

		const response = await servePublicStorageKey(
			"attachments/user/item/file.enc",
			{
				createPresignedDownload: async () => {
					presignCalls += 1;
					return "https://storage.example.com/private";
				},
			},
		);

		expect(response.status).toBe(404);
		expect(presignCalls).toBe(0);
	});

	test("should allow public team and vault image keys", async () => {
		const response = await servePublicStorageKey("teams/team-id/avatar.png", {
			createPresignedDownload: async () => "https://storage.example.com/public",
			fetchFn: async () =>
				new Response("image-bytes", {
					status: 200,
					headers: {
						"Content-Type": "image/png",
						"set-cookie": "should-be-stripped",
					},
				}),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(await response.text()).toBe("image-bytes");
	});
});
