/**
 * `KeyRef` bookkeeping, shared by every adapter and by the in-memory fake.
 *
 * The rules `port-conformance` pins — a foreign ref throws, a destroyed ref throws, destroy
 * is idempotent, a clone has its own lifetime — are properties of this table rather than of
 * any one backend. Five implementations getting them right independently is five chances to
 * get them wrong, so an adapter's only job is to say what the payload is and how to wipe it.
 *
 * One table per port instance. Refs carry no data of their own; the table holds the payload
 * and the ref is nothing but an identity, which is what makes a `KeyRef` unreadable from
 * outside and useless if it leaks.
 */

import type { KeyRef } from "./crypto-port";
import { CryptoPortError } from "./errors";

class KeyRefToken {
	toString(): string {
		return "[KeyRef]";
	}
}

export interface KeyRefTable<TPayload> {
	/** Mint a ref over `payload`. */
	create(payload: TPayload): KeyRef;
	/** The payload, or a throw — never `null`, so a caller cannot forget to check. */
	read(ref: KeyRef): TPayload;
	/**
	 * Retire `ref` and hand its payload back once so the caller can zeroize it. Returns
	 * `null` if the ref was already retired, which is what makes `destroyKey` idempotent.
	 */
	dispose(ref: KeyRef): TPayload | null;
	isLive(ref: KeyRef): boolean;
	/** Refs minted and not yet disposed. Lets a test assert a ceremony leaks nothing. */
	readonly liveCount: number;
}

export function createKeyRefTable<TPayload>(): KeyRefTable<TPayload> {
	const live = new WeakMap<KeyRef, TPayload>();
	const retired = new WeakSet<KeyRef>();
	let liveCount = 0;

	function assertKnown(ref: KeyRef): void {
		if (live.has(ref)) {
			return;
		}
		if (retired.has(ref)) {
			throw new CryptoPortError(
				"key-destroyed",
				"This key was destroyed; the material behind it has been zeroized.",
			);
		}
		throw new CryptoPortError(
			"invalid-key-ref",
			"This key reference was not created by this crypto port.",
		);
	}

	return {
		create(payload) {
			const ref = new KeyRefToken() as unknown as KeyRef;
			live.set(ref, payload);
			liveCount += 1;
			return ref;
		},

		read(ref) {
			assertKnown(ref);
			return live.get(ref) as TPayload;
		},

		dispose(ref) {
			if (!live.has(ref)) {
				// A foreign ref is still a caller bug even though a destroyed one is not.
				if (!retired.has(ref)) {
					throw new CryptoPortError(
						"invalid-key-ref",
						"This key reference was not created by this crypto port.",
					);
				}
				return null;
			}
			const payload = live.get(ref) as TPayload;
			live.delete(ref);
			retired.add(ref);
			liveCount -= 1;
			return payload;
		},

		isLive(ref) {
			return live.has(ref);
		},

		get liveCount() {
			return liveCount;
		},
	};
}
