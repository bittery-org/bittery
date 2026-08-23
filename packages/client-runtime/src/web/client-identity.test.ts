import { describe, expect, test } from "bun:test";
import {
	decodeRuntimeClientIdentity,
	encodeRuntimeClientIdentity,
} from "./client-identity";

describe("Worker client identity", () => {
	test("round-trips the identity a Worker cannot read for itself", () => {
		const identity = {
			clientId: "client_1771891200000_ab12cd3",
			platform: "web",
			version: "0.5.2",
		};
		expect(
			decodeRuntimeClientIdentity(encodeRuntimeClientIdentity(identity)),
		).toEqual(identity);
	});

	test("two browsers keep distinct client ids", () => {
		const first = encodeRuntimeClientIdentity({
			clientId: "client-a",
			platform: "web",
			version: "1.0.0",
		});
		const second = encodeRuntimeClientIdentity({
			clientId: "client-b",
			platform: "web",
			version: "1.0.0",
		});
		expect(decodeRuntimeClientIdentity(first)?.clientId).toBe("client-a");
		expect(decodeRuntimeClientIdentity(second)?.clientId).toBe("client-b");
	});

	test("answers none rather than a fabricated identity", () => {
		expect(decodeRuntimeClientIdentity(undefined)).toBeUndefined();
		expect(decodeRuntimeClientIdentity("")).toBeUndefined();
		expect(decodeRuntimeClientIdentity("some-other-worker")).toBeUndefined();
		expect(
			decodeRuntimeClientIdentity("bittery-runtime-client:not json"),
		).toBeUndefined();
		expect(
			decodeRuntimeClientIdentity('bittery-runtime-client:{"clientId":""}'),
		).toBeUndefined();
	});
});
