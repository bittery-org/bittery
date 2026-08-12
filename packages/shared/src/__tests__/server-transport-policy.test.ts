import { describe, expect, test } from "bun:test";
import { resolveInsecureTransportPolicy } from "../server-transport-policy";

describe("remote HTTP transport policy", () => {
	test("requires account confirmation before metadata discovery", async () => {
		let requested = false;
		await expect(
			resolveInsecureTransportPolicy({
				serverUrl: "http://server.example",
				accountConfirmed: false,
				fetch: async () => {
					requested = true;
					return Response.json({ capabilities: ["insecure-http"] });
				},
			}),
		).rejects.toEqual(
			expect.objectContaining({
				reason: "ACCOUNT_CONFIRMATION_REQUIRED",
			}),
		);
		expect(requested).toBe(false);
	});

	test("discovers operator enablement without sending credentials", async () => {
		const policy = await resolveInsecureTransportPolicy({
			serverUrl: "http://server.example/custom/prefix",
			accountConfirmed: true,
			fetch: async (request) => {
				expect(request.url).toBe(
					"http://server.example/custom/prefix/api/meta",
				);
				expect(request.method).toBe("GET");
				expect(request.headers.get("Authorization")).toBeNull();
				expect(request.headers.get("Bittery-Client-Id")).toBeNull();
				return Response.json({ capabilities: ["insecure-http"] });
			},
		});
		expect(policy).toEqual({
			operatorEnabled: true,
			accountConfirmed: true,
		});
	});

	test("denies the next request after the operator revokes the capability", async () => {
		await expect(
			resolveInsecureTransportPolicy({
				serverUrl: "http://server.example",
				accountConfirmed: true,
				fetch: async () => Response.json({ capabilities: [] }),
			}),
		).rejects.toEqual(
			expect.objectContaining({
				reason: "OPERATOR_DISABLED",
			}),
		);
	});
});
