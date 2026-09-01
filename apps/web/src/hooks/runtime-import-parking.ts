import { useCallback, useSyncExternalStore } from "react";
import type { ImportPreview, ImportProviderId } from "@/lib/import";

export interface RuntimeImportParkingMapping {
	sourceVaultId: string;
	mode: "create" | "existing";
	targetVaultName: string;
	targetVaultId: string | null;
}

export interface RuntimeImportParkingTarget {
	vaultId: string;
	vaultName: string;
	accountId: string;
}

export interface RuntimeImportParkingDraft {
	accountId: string;
	providerId: ImportProviderId;
	preview: ImportPreview;
	mappings: Record<string, RuntimeImportParkingMapping>;
	progress: {
		stage: "awaiting-runtime-import";
		totalItems: number;
		processedItems: number;
		totalVaults: number;
		processedVaults: number;
		currentVaultName?: string;
	};
	skippedEmptyVaultCount: number;
	parkedRuntimeTargets: Record<string, RuntimeImportParkingTarget>;
}

declare const runtimeImportParkingLeaseBrand: unique symbol;

/**
 * One Account parking generation captured by an in-flight Import operation.
 * The brand keeps lifecycle fencing behind this module's typed API rather than
 * exposing a forgeable counter or token to callers.
 */
export interface RuntimeImportParkingLease {
	readonly accountId: string;
	readonly [runtimeImportParkingLeaseBrand]: true;
}

export type RuntimeImportParkingAttempt =
	| { readonly state: "parked" }
	| { readonly state: "retired" };

export interface AccountScopedRuntimeImportParking {
	capture(accountId: string): RuntimeImportParkingLease;
	park(
		lease: RuntimeImportParkingLease,
		draft: RuntimeImportParkingDraft,
	): RuntimeImportParkingAttempt;
	release(lease: RuntimeImportParkingLease): void;
	read(accountId: string): RuntimeImportParkingDraft | null;
	retire(accountId: string): void;
	retireAll(): void;
	subscribe(accountId: string, listener: () => void): () => void;
}

function createAccountScopedRuntimeImportParking(): AccountScopedRuntimeImportParking {
	interface ParkingGeneration {
		readonly accountId: string;
		draft: RuntimeImportParkingDraft | null;
		leaseCount: number;
	}
	const generationsByAccountId = new Map<string, ParkingGeneration>();
	const generationByLease = new WeakMap<
		RuntimeImportParkingLease,
		ParkingGeneration
	>();
	const listenersByAccountId = new Map<string, Set<() => void>>();
	const notify = (accountId: string) => {
		for (const listener of listenersByAccountId.get(accountId) ?? [])
			listener();
	};

	return {
		capture(accountId) {
			let generation = generationsByAccountId.get(accountId);
			if (!generation) {
				generation = { accountId, draft: null, leaseCount: 0 };
				generationsByAccountId.set(accountId, generation);
			}
			generation.leaseCount += 1;
			const lease = { accountId } as RuntimeImportParkingLease;
			generationByLease.set(lease, generation);
			return lease;
		},
		park(lease, draft) {
			const generation = generationByLease.get(lease);
			if (!generation) {
				throw new Error("Runtime Import parking lease is not active");
			}
			if (draft.accountId !== lease.accountId) {
				throw new Error("Runtime Import parking lease targets another Account");
			}
			if (generationsByAccountId.get(lease.accountId) !== generation) {
				return { state: "retired" };
			}
			// Account identity is the isolation boundary: parking B replaces only B,
			// so decrypted draft A can never be returned from a read scoped to B.
			generation.draft = draft;
			notify(draft.accountId);
			return { state: "parked" };
		},
		release(lease) {
			const generation = generationByLease.get(lease);
			if (!generation) return;
			generationByLease.delete(lease);
			generation.leaseCount -= 1;
			if (
				generation.leaseCount === 0 &&
				generation.draft === null &&
				generationsByAccountId.get(generation.accountId) === generation
			) {
				generationsByAccountId.delete(generation.accountId);
			}
		},
		read(accountId) {
			return generationsByAccountId.get(accountId)?.draft ?? null;
		},
		retire(accountId) {
			const generation = generationsByAccountId.get(accountId);
			if (generation !== undefined) generation.draft = null;
			generationsByAccountId.delete(accountId);
			notify(accountId);
		},
		retireAll() {
			const accountIds = [...generationsByAccountId.keys()];
			for (const generation of generationsByAccountId.values())
				generation.draft = null;
			generationsByAccountId.clear();
			for (const accountId of accountIds) notify(accountId);
		},
		subscribe(accountId, listener) {
			const listeners = listenersByAccountId.get(accountId) ?? new Set();
			listeners.add(listener);
			listenersByAccountId.set(accountId, listeners);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) listenersByAccountId.delete(accountId);
			};
		},
	};
}

// Ticket 54 owns this document-session memory only. It deliberately survives a dialog
// unmount, is lost on reload, and is never copied to Web Storage. Account lifecycle owners
// must call scoped retirement when that Account's in-memory draft is retired;
// Ticket 55 replaces this presentation bridge with durable Runtime Import ownership.
export const runtimeImportParking = createAccountScopedRuntimeImportParking();

export function useParkedRuntimeImportDraft(
	accountId: string | null,
): RuntimeImportParkingDraft | null {
	const subscribe = useCallback(
		(listener: () => void) =>
			accountId === null
				? () => undefined
				: runtimeImportParking.subscribe(accountId, listener),
		[accountId],
	);
	const getSnapshot = useCallback(
		() => (accountId === null ? null : runtimeImportParking.read(accountId)),
		[accountId],
	);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
