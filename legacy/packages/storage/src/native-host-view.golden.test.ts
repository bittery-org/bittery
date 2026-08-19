/**
 * The producer half of the native-host golden documents.
 *
 * `src/__fixtures__/README.md` explains why these exist: Rust reads both of these
 * documents and there is no generator on this seam, so the two ends are pinned to a
 * committed sample instead. This file proves the sample is what the publisher really
 * writes; `apps/desktop/src-tauri/src/lib.rs` proves the consumer really reads it.
 *
 * The comparison is whole-document on purpose. Asserting field by field would let a new
 * field slip in on this side without anyone teaching Rust about it.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { createInMemoryCryptoPort } from "@bittery/crypto-port/testing";
import type { ItemCacheMetadata } from "@bittery/types";
import itemCacheStateGolden from "./__fixtures__/item-cache-state.v2.json";
import nativeHostViewGolden from "./__fixtures__/native-host-view.v3.json";
import { createAccountStore, type NativeHostView } from "./account-store";
import { createItemCache } from "./item-cache";
import { metaCollection } from "./keys";
import {
	createInMemoryPlatformPort,
	createInMemoryRecordPort,
} from "./testing/in-memory-port";
import type { AccountMetadata } from "./types";

/** The desktop adapter's record namespace; the published refs have to carry it. */
const RECORD_PREFIX = "record:";

/** Every timestamp the store stamps itself, so the document is reproducible. */
const NOW = 1700000002000;

const FIRST_ACCOUNT: AccountMetadata = {
	accountId: "account-1",
	email: "person@example.com",
	userId: "user-1",
	name: "Person",
	serverUrl: "https://vault.example.com",
	secretKeyHint: "AB-CD",
	teamName: "Acme",
	teamAvatarUrl: "https://cdn.example.com/acme.png",
	addedAt: 1700000000000,
	lastActiveAt: 1700000001000,
	biometricEnabled: true,
	insecureTransportConfirmed: true,
};

/** No team, and biometrics off — the other side of every optional field. */
const SECOND_ACCOUNT: AccountMetadata = {
	accountId: "account-2",
	email: "other@example.com",
	userId: "user-2",
	name: "Other",
	serverUrl: "https://vault.example.com",
	secretKeyHint: "EF-GH",
	teamAvatarUrl: null,
	addedAt: 1700000000500,
	lastActiveAt: 1700000000500,
	biometricEnabled: false,
	insecureTransportConfirmed: false,
};

describe("bittery_native_view golden document", () => {
	it("publishes exactly the document the native host is tested against", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);

		const port = createInMemoryPlatformPort({
			sessionSurvivesRestart: true,
			recordKeyPrefix: RECORD_PREFIX,
		});
		const crypto = createInMemoryCryptoPort();
		const store = createAccountStore({ port, crypto });
		await store.initialize();
		await store.addAccount(FIRST_ACCOUNT);
		await store.addAccount(SECOND_ACCOUNT);
		await store.setActiveAccount(FIRST_ACCOUNT.accountId);
		// One account unlocked and one not, driven through the real path — the
		// unlocked set is what the native host answers `GET_DESKTOP_STATUS` from.
		await store.setMasterUnlockKey(await crypto.importKey(new Uint8Array(32)));

		const published = port.snapshot().device.bittery_native_view;
		expect(published).toBeDefined();

		const view = JSON.parse(published as string) as NativeHostView;
		expect(view).toEqual(nativeHostViewGolden as unknown as NativeHostView);
	});
});

describe("item cache state golden document", () => {
	it("publishes exactly the record the native host follows", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);

		const port = createInMemoryRecordPort({ recordKeyPrefix: RECORD_PREFIX });
		const cache = createItemCache({ port });
		await cache.initialize();
		await cache.setCachedItems([], FIRST_ACCOUNT.accountId);
		await cache.setCachedVaults([], FIRST_ACCOUNT.accountId);
		await cache.setItemCacheMetadata(
			{
				lastFullSyncAt: NOW,
				itemCount: 0,
				cacheVersion: 1,
			} satisfies ItemCacheMetadata,
			FIRST_ACCOUNT.accountId,
		);

		const raw = await port.recordGet(
			metaCollection(FIRST_ACCOUNT.accountId),
			"meta",
		);
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw as string)).toEqual(itemCacheStateGolden);
	});
});
