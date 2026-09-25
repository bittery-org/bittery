import { expect, test } from "bun:test";
import { NativeMessagingClient } from "../../src/background/native-messaging-client";

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => (release = resolve));
	return { promise, release };
}

test("a genuine local successor supersedes old native failure cleanup without native retention", async () => {
	const client = new NativeMessagingClient();
	const generation = await client.captureDeliveryGeneration();
	const invocation = client.newMaterialInvocation();
	const entered = deferred();
	const held = deferred();
	const oldWrite = client.withMaterialMutation(
		generation,
		"account-a",
		async (_check, markMaterialWrite) => {
			markMaterialWrite();
			entered.release();
			await held.promise;
			throw new Error("partial native write");
		},
		invocation,
	);
	await entered.promise;
	let localPublished = false;
	const localWrite = client.withLocalMaterialMutation(
		generation,
		"account-a",
		async (check) => {
			check();
			localPublished = true;
		},
	);
	held.release();
	await expect(oldWrite).rejects.toThrow("partial native write");
	await localWrite;
	let oldCleanupRan = false;
	await client.withOwnedFailureCleanup(
		generation,
		"account-a",
		invocation,
		async () => {
			oldCleanupRan = true;
			throw new Error("old cleanup erased a local successor");
		},
	);
	expect(localPublished).toBe(true);
	expect(oldCleanupRan).toBe(false);
	expect(client.needsMaterialCleanup()).toBe(false);
});

test("false and already-present local restore do not discharge native ownership", async () => {
	for (const restored of [false, true]) {
		const client = new NativeMessagingClient();
		const generation = await client.captureDeliveryGeneration();
		await client.withMaterialMutation(
			generation,
			"account-a",
			async (_check, markMaterialWrite) => {
				markMaterialWrite();
				return true;
			},
		);
		const result = await client.withLocalMaterialMutation(
			generation,
			"account-a",
			async () => restored,
			() => false,
		);
		expect(result).toBe(restored);
		expect(client.needsMaterialCleanup()).toBe(true);
	}
});

test("an already started local setter drains before its C1 cleanup without self-deadlock", async () => {
	const client = new NativeMessagingClient();
	const generation = await client.captureDeliveryGeneration();
	const setterEntered = deferred();
	const setterHeld = deferred();
	const cleanupEntered = deferred();
	let material = false;
	client.configureRetirementCleanup(async () => {
		cleanupEntered.release();
		expect(material).toBe(true);
		material = false;
	});
	const setter = client.withLocalMaterialMutation(
		generation,
		"account-a",
		async (check) => {
			check();
			setterEntered.release();
			await setterHeld.promise;
			material = true;
		},
	);
	await setterEntered.promise;
	const retirement = client.retireObservedStatus({
		locked: true,
		timestamp: 1,
	});
	let cleanupStarted = false;
	void cleanupEntered.promise.then(() => {
		cleanupStarted = true;
	});
	await Promise.resolve();
	expect(cleanupStarted).toBe(false);
	setterHeld.release();
	await expect(setter).rejects.toThrow("Native delivery retired");
	await retirement;
	expect(material).toBe(false);
	const fresh = await client.captureDeliveryGeneration();
	await client.withLocalMaterialMutation(fresh, "account-a", async () => {
		material = true;
	});
	expect(material).toBe(true);
});

test("failed C1 refuses local publication; a failed Desktop probe leaves pure local usable", async () => {
	const client = new NativeMessagingClient();
	const generation = await client.captureDeliveryGeneration();
	let published = false;
	await client.withLocalMaterialMutation(generation, "account-a", async () => {
		published = true;
	});
	expect(published).toBe(true);
	expect(client.needsMaterialCleanup()).toBe(false);
	await expect(client.request({ type: "GET_DESKTOP_STATUS" })).rejects.toThrow(
		"chrome.runtime.connectNative is unavailable",
	);
	await client.withLocalMaterialMutation(generation, "account-a", async () => {
		published = true;
	});
	expect(client.needsMaterialCleanup()).toBe(false);

	const failed = new NativeMessagingClient();
	const errorLog = console.error;
	console.error = () => {};
	try {
		failed.configureRetirementCleanup(async () => {
			throw new Error("C1 incomplete");
		});
		const cleanup = failed.retireObservedStatus({ locked: true, timestamp: 1 });
		await expect(cleanup).rejects.toThrow("C1 incomplete");
		await expect(failed.captureDeliveryGeneration()).rejects.toThrow(
			"C1 incomplete",
		);
	} finally {
		console.error = errorLog;
	}
});
