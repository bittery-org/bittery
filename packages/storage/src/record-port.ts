/**
 * The bulk-record seam.
 *
 * Separate from `PlatformPort` because the trust and durability story is different:
 * these are disposable encrypted blobs (the vault item cache). Losing this store costs
 * a re-sync, not a lockout, so it never belongs in a keychain.
 *
 * Like `PlatformPort`, every method is total and there are ZERO optional members.
 */

/**
 * Bulk record storage for disposable encrypted blobs. Losing this costs a re-sync.
 * `collection` is an opaque namespace string chosen by ItemCache; ports must not parse it.
 *
 * `recordPut` / `recordDelete` **must be O(1)** — no read-whole-array-mutate-rewrite.
 * `vault-repository.ts` upserts one item at a time on delta sync, so a rewrite-the-world
 * implementation turns a delta sync into O(n^2) writes. Adapters back this with a real
 * per-record store (sqlite row, IndexedDB key, one store key per record).
 */
export interface RecordPort {
	initialize(): Promise<void>;
	recordPut(collection: string, id: string, value: string): Promise<void>;
	recordGet(collection: string, id: string): Promise<string | null>;
	recordDelete(collection: string, id: string): Promise<void>;
	recordList(collection: string): Promise<Array<{ id: string; value: string }>>;
	recordClear(collection: string): Promise<void>;
}
