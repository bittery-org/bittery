import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRuntimeClient } from "@bittery/client-runtime/client";
import {
	getRuntimeAccountId,
	parseRuntimeSignedIn,
	requestRuntimeSignIn,
	runtimeSignInRequestJson,
	setRuntimeAccountId,
} from "./runtime-auth";
import { mapRuntimeItemsProjection } from "./runtime-items";

afterEach(() => {
	setRuntimeAccountId(null);
});

describe("Runtime Sign-in", () => {
	test("builds the closed Sign-in request and parses a signed-in Account", () => {
		const requestJson = runtimeSignInRequestJson({
			serverUrl: "https://vault.example.com",
			email: "user-1@example.com",
			masterPassword: "correct horse battery staple",
			secretKey: "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2",
			insecureTransportConfirmed: false,
		});
		expect(JSON.parse(requestJson)).toEqual({
			type: "signIn",
			serverUrl: "https://vault.example.com",
			email: "user-1@example.com",
			masterPassword: "correct horse battery staple",
			secretKey: "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2",
			insecureTransportConfirmed: false,
		});
		expect(
			parseRuntimeSignedIn(
				JSON.stringify({
					type: "succeeded",
					value: {
						type: "signedIn",
						accountId: "account-runtime",
						userId: "user-1",
					},
				}),
			),
		).toEqual({ accountId: "account-runtime", userId: "user-1" });
		// The semantic code, not the Rust diagnostic string, is what the UI branches on.
		expect(() =>
			parseRuntimeSignedIn(
				JSON.stringify({
					type: "failed",
					value: {
						code: "AUTHENTICATION_REQUIRED",
						message: "Session is missing or expired",
					},
				}),
			),
		).toThrow(expect.objectContaining({ code: "AUTHENTICATION_REQUIRED" }));
	});

	test("observes Items for the Account a Runtime Sign-in installed, not an empty catch", async () => {
		const host = {
			requests: [] as Array<{ requestId: string; requestJson: string }>,
			async request(requestId: string, requestJson: string) {
				this.requests.push({ requestId, requestJson });
				return JSON.stringify({
					type: "succeeded",
					value: {
						type: "signedIn",
						accountId: "account-runtime",
						userId: "user-1",
					},
				});
			},
			async observe(
				_observationId: string,
				requestJson: string,
				listener: (projectionJson: string) => void,
			) {
				expect(JSON.parse(requestJson)).toEqual({
					type: "items",
					accountId: "account-runtime",
				});
				listener(
					JSON.stringify({
						type: "items",
						value: {
							accountId: "account-runtime",
							replicaRevision: 4,
							items: [
								{
									itemId: "item-1",
									accountId: "account-runtime",
									vaultId: "vault-1",
									title: "Bank",
									status: "authoritative",
									favorite: true,
									createdAt: "2026-08-23T00:00:00Z",
									updatedAt: "2026-08-23T00:00:00Z",
								},
							],
						},
					}),
				);
			},
			async unobserve() {
				return;
			},
			async close() {
				return;
			},
		};
		const signedIn = await requestRuntimeSignIn(
			host,
			"sign-in-1",
			runtimeSignInRequestJson({
				serverUrl: "https://vault.example.com",
				email: "user-1@example.com",
				masterPassword: "correct horse battery staple",
				secretKey: "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2",
				insecureTransportConfirmed: false,
			}),
		);
		expect(signedIn.accountId).toBe("account-runtime");
		expect(getRuntimeAccountId()).toBe("account-runtime");
		expect(JSON.parse(host.requests[0]?.requestJson ?? "{}").type).toBe(
			"signIn",
		);

		const store = createRuntimeClient({ transport: host }).items(
			signedIn.accountId,
		);
		store.subscribe(() => undefined);
		for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();

		const snapshot = store.getSnapshot();
		if (snapshot.state !== "ready") {
			throw new Error(`Items observation is ${snapshot.state}`);
		}
		expect(
			mapRuntimeItemsProjection(snapshot.value).map((item) => ({
				id: item.id,
				favorite: item.favorite,
			})),
		).toEqual([{ id: "item-1", favorite: true }]);
	});

	test("Web Sign-in form routes Full Sign-in and Quick Unlock through Runtime", () => {
		const source = readFileSync(
			new URL("../components/sign-in-form.tsx", import.meta.url),
			"utf8",
		);
		expect(source).toContain("signInWithRuntime");
		expect(source).toContain("quickUnlockWithRuntime");
		expect(source).not.toContain("performSRPLogin");
		expect(source).not.toContain("unlockAccountWithPassword");
	});
});
