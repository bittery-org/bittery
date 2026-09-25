import { describe, expect, test } from "bun:test";
import type { RuntimeProjection } from "@bittery/client-runtime/protocol";
import type { RuntimeBridgeMessage } from "../generated/tauri-commands";
import {
	connectDesktopRuntime,
	type DesktopRuntimeBridge,
} from "./runtime-transport";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function bridgeFixture() {
	let listener: ((message: RuntimeBridgeMessage) => void) | undefined;
	const calls: Array<{ type: string; callId?: string }> = [];
	let requestAdmission = Promise.resolve();
	let observationAdmission = Promise.resolve();
	const bridge: DesktopRuntimeBridge = {
		runtimeAttach: async () => ({
			connectionId: "connection-a",
			eventName: "runtime-test",
		}),
		listenRuntimeBridge: async (_event, receive) => {
			listener = receive;
			return () => {
				calls.push({ type: "unlisten" });
			};
		},
		runtimeRequest: async ({ callId }) => {
			calls.push({ type: "request", callId });
			await requestAdmission;
		},
		runtimeObserve: async ({ callId }) => {
			calls.push({ type: "observe", callId });
			await observationAdmission;
		},
		runtimeCancel: async ({ callId }) => {
			calls.push({ type: "cancel", callId });
		},
		runtimeUnobserve: async ({ callId }) => {
			calls.push({ type: "unobserve", callId });
		},
		runtimeDetach: async () => {
			calls.push({ type: "detach" });
		},
	};
	return {
		bridge,
		calls,
		requestAdmission: (promise: Promise<void>) => {
			requestAdmission = promise;
		},
		observationAdmission: (promise: Promise<void>) => {
			observationAdmission = promise;
		},
		send: (
			kind: RuntimeBridgeMessage["kind"],
			callId: string,
			payloadJson: string,
			connectionId = "connection-a",
		) => listener?.({ connectionId, callId, kind, payloadJson }),
	};
}

const status = JSON.stringify({
	type: "runtimeStatus",
	value: { accountId: null, accounts: [], closed: false, revision: "0" },
} satisfies RuntimeProjection);
const failure = JSON.stringify({
	type: "failed",
	value: { code: "ACCOUNT_MISSING", message: "diagnostic only" },
});
const flush = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("native Runtime renderer transport", () => {
	test("receives an outcome before admission acknowledgement and fences another connection", async () => {
		const fixture = bridgeFixture();
		const admission = deferred<void>();
		fixture.requestAdmission(admission.promise);
		const transport = await connectDesktopRuntime(fixture.bridge);
		const response = transport.request("caller", "{}");
		const id = fixture.calls[0]?.callId as string;
		fixture.send("response", id, "not JSON", "old-connection");
		fixture.send("response", id, failure);
		expect(await response).toBe(failure);
		admission.resolve();
		await transport.close();
	});

	test("abort stops waiting immediately but native cancellation waits for request admission", async () => {
		const fixture = bridgeFixture();
		const admission = deferred<void>();
		fixture.requestAdmission(admission.promise);
		const transport = await connectDesktopRuntime(fixture.bridge);
		const abort = new AbortController();
		const response = transport.request("same", "{}", { signal: abort.signal });
		const rejected = response.catch((cause: unknown) => cause);
		const oldId = fixture.calls[0]?.callId as string;
		abort.abort();
		expect(await rejected).toMatchObject({ code: "CANCELLED" });
		expect(fixture.calls.map((call) => call.type)).toEqual(["request"]);
		fixture.requestAdmission(Promise.resolve());
		const next = transport.request("same", "{}");
		const nextId = fixture.calls[1]?.callId as string;
		expect(nextId).not.toBe(oldId);
		fixture.send("response", oldId, failure);
		admission.resolve();
		await flush();
		expect(fixture.calls).toContainEqual({ type: "cancel", callId: oldId });
		fixture.send("response", nextId, failure);
		expect(await next).toBe(failure);
		await transport.close();
	});

	test("retired observation ignores late values even when a caller ID is reused", async () => {
		const fixture = bridgeFixture();
		const admission = deferred<void>();
		fixture.observationAdmission(admission.promise);
		const transport = await connectDesktopRuntime(fixture.bridge);
		const values: string[] = [];
		const observing = transport.observe("same", "{}", (value) =>
			values.push(value),
		);
		const oldId = fixture.calls[0]?.callId as string;
		const retired = transport.unobserve("same");
		fixture.send("projection", oldId, status);
		expect(values).toEqual([]);
		admission.resolve();
		await observing;
		await retired;
		fixture.observationAdmission(Promise.resolve());
		await transport.observe("same", "{}", (value) => values.push(value));
		const newId = fixture.calls.filter((call) => call.type === "observe").at(-1)
			?.callId as string;
		fixture.send("projection", oldId, status);
		fixture.send("projection", newId, "{}");
		fixture.send("projection", newId, status);
		expect(values).toEqual([status]);
		await transport.close();
	});

	test("close detaches once and rejects waiters without closing the native owner", async () => {
		const fixture = bridgeFixture();
		const transport = await connectDesktopRuntime(fixture.bridge);
		const response = transport.request("call", "{}");
		const rejected = response.catch((cause: unknown) => cause);
		await transport.close();
		await transport.close();
		expect(await rejected).toMatchObject({ code: "RUNTIME_CLOSED" });
		expect(fixture.calls.filter((call) => call.type === "detach")).toHaveLength(
			1,
		);
		await expect(transport.request("late", "{}")).rejects.toMatchObject({
			code: "RUNTIME_CLOSED",
		});
	});

	test("preserves generated native error codes and rejects malformed outcomes", async () => {
		const fixture = bridgeFixture();
		fixture.bridge.runtimeRequest = async () => {
			throw { code: "STORAGE_UNAVAILABLE", message: "private diagnostic" };
		};
		const transport = await connectDesktopRuntime(fixture.bridge);
		await expect(transport.request("call", "{}")).rejects.toMatchObject({
			code: "STORAGE_UNAVAILABLE",
		});
		await transport.close();
		const second = bridgeFixture();
		const next = await connectDesktopRuntime(second.bridge);
		const response = next.request("call", "{}");
		second.send("response", second.calls[0]?.callId as string, "{}");
		await expect(response).rejects.toMatchObject({
			code: "INVARIANT_VIOLATION",
		});
		await next.close();
	});
});
