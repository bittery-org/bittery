/**
 * The Device session a host renders, derived from the Runtime's own publication.
 *
 * Two things live here that every host needs and no host should reinvent. The first is the
 * **derivation**: one `RuntimeStatus` observation, opened Device-wide so no missing Account
 * can make it fail, folded into the states a UI actually branches on. The second is the
 * **active-Account pointer**, which stays a host UI selection per ticket 08 but is
 * reconciled against the observed catalog on every read, so a pointer the Runtime no longer
 * recognises can never decide which Account a password unlocks.
 *
 * Nothing here reads a browser global. Persistence arrives injected, so `localStorage` on
 * Web and `chrome.storage.local` in an Extension are the same seam.
 */

import type {
	AccountStatus,
	AccountWaitingReason,
	RuntimeErrorCode,
	RuntimeStatusProjection,
} from "../../generated/runtime-protocol/contract";
import type { RuntimeSnapshot, RuntimeStore, Subscribable } from "./store";

/**
 * What the Device can tell the host about the Account it is pointing at.
 *
 * `locked` and `signedOut` are the distinction a password manager cannot afford to lose:
 * `locked` means the master password alone reopens the Account, `signedOut` means email,
 * master password, and Secret Key again. `missing` means the host is pointing at an Account
 * the Runtime does not have — a stale pointer, not a state the user can act on.
 */
export type RuntimeSessionState =
	| "loading"
	| "unavailable"
	| "missing"
	| "signedOut"
	| "locked"
	| "unlocked";

export interface RuntimeSessionSnapshot {
	readonly state: RuntimeSessionState;
	/** The reconciled active Account. Never a pointer the observed catalog denies. */
	readonly accountId: string | null;
	/** Every Account this Device holds, so a host can offer a switch. */
	readonly accounts: readonly AccountStatus[];
	readonly waitingReason: AccountWaitingReason | null;
	/**
	 * The semantic code the UI branches on: the observation's failure, or the Account's.
	 * The Rust `message` never travels with it; it is diagnostic text and is not localized.
	 */
	readonly code: RuntimeErrorCode | null;
}

/**
 * Where the host keeps its active-Account pointer. Synchronous on purpose: a snapshot getter
 * cannot await. A host whose real store is asynchronous hydrates this one at startup and
 * writes through.
 */
export interface ActiveAccountStorage {
	read(): string | null;
	write(accountId: string | null): void;
}

export interface WebStorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export const ACTIVE_ACCOUNT_STORAGE_KEY = "bittery_runtime_account_id";

export function createMemoryActiveAccountStorage(
	initial: string | null = null,
): ActiveAccountStorage {
	let value = initial;
	return {
		read: () => value,
		write: (accountId) => {
			value = accountId;
		},
	};
}

/** `localStorage` for Web, or any store shaped like it. */
export function createWebActiveAccountStorage(
	storage: WebStorageLike,
	key: string = ACTIVE_ACCOUNT_STORAGE_KEY,
): ActiveAccountStorage {
	return {
		read: () => storage.getItem(key),
		write: (accountId) => {
			if (accountId === null) storage.removeItem(key);
			else storage.setItem(key, accountId);
		},
	};
}

/** What a host renders before the Device has answered, and during a prerender. */
export const LOADING_SESSION: RuntimeSessionSnapshot = Object.freeze({
	state: "loading",
	accountId: null,
	accounts: Object.freeze([]) as readonly AccountStatus[],
	waitingReason: null,
	code: null,
});

/**
 * Picks the Account an action applies to.
 *
 * `preferred` is the Account the caller is acting on right now — the one a login form is
 * offering to unlock. It outranks the stored pointer, because the stored pointer is a
 * memory of a past session and the offer is the present one. Both must survive the catalog.
 * With neither, a Device holding exactly one Account has no ambiguity to resolve, so that
 * Account is adopted; several Accounts and no pointer means the host must still choose.
 */
export function reconcileAccount(
	accounts: readonly AccountStatus[],
	stored: string | null,
	preferred?: string | null,
): string | null {
	const known = (candidate: string | null | undefined): candidate is string =>
		candidate != null &&
		accounts.some((account) => account.accountId === candidate);
	if (known(preferred)) return preferred;
	if (known(stored)) return stored;
	return accounts.length === 1 ? (accounts[0]?.accountId ?? null) : null;
}

/** Folds one Device status snapshot and the host's pointer into what a UI renders. */
export function deriveSession(
	status: RuntimeSnapshot<RuntimeStatusProjection>,
	stored: string | null,
): RuntimeSessionSnapshot {
	if (status.state === "idle" || status.state === "loading")
		return LOADING_SESSION;
	if (status.state === "failed") {
		return frozen({ state: "unavailable", code: status.code });
	}
	const { accounts, closed } = status.value;
	if (closed) {
		return frozen({ state: "unavailable", accounts, code: "RUNTIME_CLOSED" });
	}
	const accountId = reconcileAccount(accounts, stored);
	if (accountId === null) {
		// A pointer the catalog denies is not the same answer as a Device with no Account.
		return frozen({
			state: stored === null ? "signedOut" : "missing",
			accounts,
		});
	}
	const account = accounts.find((entry) => entry.accountId === accountId);
	return frozen({
		state: account?.access ?? "signedOut",
		accountId,
		accounts,
		waitingReason: account?.waitingReason ?? null,
		code: account?.failure ?? null,
	});
}

function frozen(
	partial: Partial<RuntimeSessionSnapshot> & { state: RuntimeSessionState },
): RuntimeSessionSnapshot {
	return Object.freeze({ ...LOADING_SESSION, ...partial });
}

/**
 * Owns the pointer and the derived store. One instance per client: the store handle is
 * identity, so a host that re-reads `session()` gets the object it already subscribed to.
 */
export class RuntimeSession {
	readonly #status: RuntimeStore<RuntimeStatusProjection>;
	readonly #storage: ActiveAccountStorage;
	readonly #subscribers = new Set<() => void>();
	#stored: string | null;
	#lastStatus: RuntimeSnapshot<RuntimeStatusProjection> | undefined;
	#lastStored: string | null | undefined;
	#cached: RuntimeSessionSnapshot = LOADING_SESSION;

	readonly store: Subscribable<RuntimeSessionSnapshot>;

	constructor(
		status: RuntimeStore<RuntimeStatusProjection>,
		storage: ActiveAccountStorage,
	) {
		this.#status = status;
		this.#storage = storage;
		this.#stored = storage.read();
		this.store = {
			subscribe: (onStoreChange) => {
				this.#subscribers.add(onStoreChange);
				// Subscribing upstream is what opens the Device-wide observation; the
				// registry below refcounts it, so N consumers still share one.
				const release = this.#status.subscribe(onStoreChange);
				return () => {
					this.#subscribers.delete(onStoreChange);
					release();
				};
			},
			getSnapshot: () => this.#snapshot(),
		};
	}

	/** Moves the host's pointer and tells everyone watching. */
	select(accountId: string | null): void {
		if (this.#stored === accountId) return;
		this.#stored = accountId;
		this.#storage.write(accountId);
		for (const notify of [...this.#subscribers]) notify();
	}

	/**
	 * The Account an action applies to. While the catalog has not arrived there is nothing
	 * to reconcile against, so the caller's own offer stands: refusing would leave a host
	 * unable to unlock during startup, and inventing a catalog would be worse.
	 */
	resolve(preferred?: string | null): string | null {
		const status = this.#status.getSnapshot();
		if (status.state !== "ready") return preferred ?? this.#stored;
		return reconcileAccount(status.value.accounts, this.#stored, preferred);
	}

	#snapshot(): RuntimeSessionSnapshot {
		const status = this.#status.getSnapshot();
		if (status === this.#lastStatus && this.#stored === this.#lastStored) {
			return this.#cached;
		}
		this.#lastStatus = status;
		this.#lastStored = this.#stored;
		this.#cached = deriveSession(status, this.#stored);
		return this.#cached;
	}
}
