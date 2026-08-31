import type { VaultImageSourceControlRequest } from "../generated/vault-image-control/contract";
import { validateVaultImageSourceControlRequest } from "../generated/vault-image-control/validator";
import {
	inspectUint8ArrayIntrinsic,
	isFullOwnedUint8Array,
	wipeBinaryIntrinsic,
} from "./binary-intrinsics";

export interface AtomicVaultImageSource {
	read(maxBytes: number): Promise<Uint8Array | null>;
	close(): Promise<void>;
}
export interface VaultImageSourceGrant {
	accountId: string;
	operationId: string;
	vaultId: string;
	contentType: string;
	byteLength: bigint;
	source: AtomicVaultImageSource;
	expiresAt?: number;
}
export type VaultImageSourceAnswer = {
	type:
		| "claimed"
		| "chunk"
		| "end"
		| "closed"
		| "retired"
		| "acceptanceBegun"
		| "acceptanceEnded"
		| "sourceFailure"
		| "cancelled"
		| "invariantViolation";
	binaryChunk?: Uint8Array;
};
type Entry = VaultImageSourceGrant & {
	capabilityId: string;
	incarnation: string;
	expiresAt: number;
	state: "granted" | "claimed" | "cleanupPending";
	readBytes: bigint;
	tail: Promise<void>;
	cleanup?: Promise<void>;
};
type Tombstone = {
	incarnation: string;
	accountId: string;
	operationId: string;
};
type Account = {
	phase: "active" | "pendingRetirement" | "retired";
	generation: number;
	acceptances: number;
	drained: Promise<void>;
	notify?: () => void;
};
const MIME = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/avif",
]);
const ID = /^[A-Za-z0-9._~-]{1,128}$/;
const MAX_LIFETIME_MS = 60 * 60_000;
export const MAX_VAULT_IMAGE_SOURCE_IDENTITIES = 1024;
export type WebVaultImageSourceRegistryOptions = {
	now?: () => number;
	identity?: () => string;
	defaultLifetimeMs?: number;
};

const activation = new WeakMap<
	WebVaultImageSourceRegistry,
	(incarnation: string) => Promise<void>
>();
export const activateWebVaultImageSourceRegistry = (
	registry: WebVaultImageSourceRegistry,
	incarnation: string,
) => {
	const activate = activation.get(registry);
	if (activate === undefined) throw new Error("Unknown Vault-image registry");
	return activate(incarnation);
};
export const replaceFailedOpenVaultImageSourceRegistry = async (
	registry: WebVaultImageSourceRegistry,
	options: WebVaultImageSourceRegistryOptions = {},
) => {
	await registry.drainClose();
	return new WebVaultImageSourceRegistry(options);
};

export class WebVaultImageSourceRegistry {
	readonly #entries = new Map<string, Entry>();
	readonly #tombstones = new Map<string, Tombstone>();
	readonly #accounts = new Map<string, Account>();
	readonly #operations = new Set<Promise<unknown>>();
	readonly #acceptanceReleases = new Map<string, () => void>();
	readonly #now: () => number;
	readonly #identity: () => string;
	readonly #lifetime: number;
	#incarnation?: string;
	#phase: "uninitialized" | "fenced" | "open" | "closing" | "closed" =
		"uninitialized";
	constructor(options: WebVaultImageSourceRegistryOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#identity = options.identity ?? randomIdentity;
		this.#lifetime = options.defaultLifetimeMs ?? 300_000;
		if (
			!Number.isFinite(this.#now()) ||
			!Number.isFinite(this.#lifetime) ||
			this.#lifetime <= 0 ||
			this.#lifetime > MAX_LIFETIME_MS
		)
			throw new Error("Vault-image source lifetime is invalid");
		activation.set(this, async (incarnation) => {
			if (
				!ID.test(incarnation) ||
				this.#phase === "closing" ||
				this.#phase === "closed"
			)
				throw new Error("Vault-image Runtime incarnation is invalid");
			if (this.#phase === "open" && this.#incarnation === incarnation) return;
			this.#phase = "fenced";
			await this.#cleanupAll();
			if (this.#entries.size !== 0)
				throw new Error("Vault-image source cleanup did not drain");
			this.#incarnation = incarnation;
			this.#accounts.clear();
			this.#tombstones.clear();
			this.#phase = "open";
		});
	}
	grant(grant: VaultImageSourceGrant): string {
		if (
			this.#phase !== "open" ||
			this.#incarnation === undefined ||
			!ID.test(grant.accountId) ||
			!ID.test(grant.operationId) ||
			!ID.test(grant.vaultId) ||
			!MIME.has(grant.contentType) ||
			grant.byteLength < 1n ||
			grant.byteLength > 2_097_152n ||
			(this.#accounts.get(grant.accountId)?.phase !== undefined &&
				this.#accounts.get(grant.accountId)?.phase !== "active")
		)
			throw new Error("Vault-image source grant is invalid");
		const account = this.#accounts.get(grant.accountId);
		this.#capacity(account === undefined ? 2 : 1);
		const capabilityId = this.#identity();
		if (
			!ID.test(capabilityId) ||
			this.#entries.has(capabilityId) ||
			this.#tombstones.has(capabilityId)
		)
			throw new Error("Vault-image capability identity is invalid");
		const now = this.#now();
		const expiresAt = grant.expiresAt ?? now + this.#lifetime;
		if (
			!Number.isFinite(now) ||
			!Number.isFinite(expiresAt) ||
			expiresAt <= now ||
			expiresAt - now > MAX_LIFETIME_MS
		)
			throw new Error("Vault-image source expiry is invalid");
		if (account === undefined)
			this.#accounts.set(grant.accountId, accountState());
		this.#entries.set(capabilityId, {
			...grant,
			capabilityId,
			incarnation: this.#incarnation,
			expiresAt,
			state: "granted",
			readBytes: 0n,
			tail: Promise.resolve(),
		});
		return capabilityId;
	}
	async invoke(
		controlJson: string,
		incarnation: string,
	): Promise<VaultImageSourceAnswer> {
		let request: VaultImageSourceControlRequest;
		try {
			const parsed: unknown = JSON.parse(controlJson);
			if (!validateVaultImageSourceControlRequest(parsed))
				return { type: "invariantViolation" };
			request = parsed;
		} catch {
			return { type: "invariantViolation" };
		}
		const canReleaseAcceptance =
			request.type === "endAcceptance" &&
			(this.#phase === "fenced" || this.#phase === "closing");
		if (
			!ID.test(incarnation) ||
			this.#incarnation !== incarnation ||
			(this.#phase !== "open" && !canReleaseAcceptance)
		)
			return { type: "sourceFailure" };
		if (request.type === "retireAccount") {
			try {
				await this.retireAccount(incarnation, request.accountId);
				return { type: "retired" };
			} catch {
				return { type: "sourceFailure" };
			}
		}
		if (request.type === "completeAccountRetirement") {
			try {
				this.reactivateAccount(incarnation, request.accountId);
				return { type: "retired" };
			} catch {
				return { type: "sourceFailure" };
			}
		}
		if (request.type === "retireRuntime") {
			try {
				await this.retireRuntime(incarnation);
				return { type: "retired" };
			} catch {
				return { type: "sourceFailure" };
			}
		}
		if (request.type === "beginAcceptance") {
			const acceptance = acceptanceKey(request.accountId, request.operationId);
			if (this.#acceptanceReleases.has(acceptance))
				return { type: "invariantViolation" };
			const release = this.beginAcceptance(
				incarnation,
				request.accountId,
				request.operationId,
			);
			if (release === undefined) return { type: "sourceFailure" };
			this.#acceptanceReleases.set(acceptance, release);
			return { type: "acceptanceBegun" };
		}
		if (request.type === "endAcceptance") {
			const acceptance = acceptanceKey(request.accountId, request.operationId);
			const release = this.#acceptanceReleases.get(acceptance);
			if (release === undefined) return { type: "sourceFailure" };
			this.#acceptanceReleases.delete(acceptance);
			release();
			return { type: "acceptanceEnded" };
		}
		const capabilityId = request.capabilityId;
		if (typeof capabilityId !== "string" || !ID.test(capabilityId))
			return { type: "invariantViolation" };
		const entry = this.#entries.get(capabilityId);
		if (entry === undefined)
			return {
				type:
					request.type === "close" &&
					this.#tombstones.get(capabilityId)?.incarnation === incarnation
						? "closed"
						: "sourceFailure",
			};
		if (request.type === "close") {
			try {
				await this.#cleanup(entry);
				return { type: "closed" };
			} catch {
				return { type: "sourceFailure" };
			}
		}
		return this.#enqueue(entry, async () => {
			if (
				entry.incarnation !== incarnation ||
				this.#accounts.get(entry.accountId)?.phase !== "active"
			)
				return { type: "cancelled" };
			if (entry.expiresAt <= this.#now()) {
				try {
					await this.#cleanupFromOperation(entry);
				} catch {}
				return { type: "sourceFailure" };
			}
			if (request.type === "claim") {
				if (
					entry.state !== "granted" ||
					request.accountId !== entry.accountId ||
					request.operationId !== entry.operationId ||
					request.vaultId !== entry.vaultId ||
					request.contentType !== entry.contentType ||
					request.byteLength !== entry.byteLength.toString()
				)
					return { type: "sourceFailure" };
				entry.state = "claimed";
				return { type: "claimed" };
			}
			if (
				request.type !== "read" ||
				entry.state !== "claimed" ||
				typeof request.maxBytes !== "number" ||
				!Number.isSafeInteger(request.maxBytes) ||
				request.maxBytes < 1 ||
				request.maxBytes > 262_144
			)
				return { type: "sourceFailure" };
			let chunk: Uint8Array | null;
			try {
				chunk = await entry.source.read(request.maxBytes);
			} catch {
				return { type: "sourceFailure" };
			}
			if (
				this.#isCleaning(entry) ||
				this.#accounts.get(entry.accountId)?.phase !== "active"
			) {
				if (chunk !== null) wipeBinaryIntrinsic(chunk);
				return { type: "cancelled" };
			}
			if (chunk === null) return { type: "end" };
			const view = inspectUint8ArrayIntrinsic(chunk);
			if (
				view === undefined ||
				!view.hasOnlyIndexedOwnData ||
				!isFullOwnedUint8Array(view) ||
				view.byteLength === 0 ||
				view.byteLength > request.maxBytes
			) {
				wipeBinaryIntrinsic(chunk);
				return { type: "invariantViolation" };
			}
			entry.readBytes += BigInt(view.byteLength);
			if (entry.readBytes > entry.byteLength) {
				wipeBinaryIntrinsic(chunk);
				return { type: "sourceFailure" };
			}
			return { type: "chunk", binaryChunk: chunk };
		});
	}
	beginAcceptance(
		incarnation: string,
		accountId: string,
		operationId: string,
	): (() => void) | undefined {
		const account = this.#accounts.get(accountId);
		if (
			this.#phase !== "open" ||
			this.#incarnation !== incarnation ||
			account === undefined ||
			account.phase !== "active" ||
			![...this.#tombstones.values()].some(
				(owner) =>
					owner.incarnation === incarnation &&
					owner.accountId === accountId &&
					owner.operationId === operationId,
			)
		)
			return undefined;
		account.acceptances += 1;
		let done = false;
		return () => {
			if (done) return;
			done = true;
			account.acceptances -= 1;
			if (account.acceptances === 0) account.notify?.();
		};
	}
	admitAcceptance(
		incarnation: string,
		accountId: string,
		operationId: string,
	): boolean {
		const release = this.beginAcceptance(incarnation, accountId, operationId);
		if (release === undefined) return false;
		release();
		return true;
	}
	async retireAccount(incarnation: string, accountId: string): Promise<void> {
		if (this.#incarnation !== incarnation || !ID.test(accountId))
			throw new Error("Vault-image Account retirement is invalid");
		const account = this.#accounts.get(accountId) ?? accountState();
		this.#accounts.set(accountId, account);
		account.phase = "pendingRetirement";
		await Promise.all(
			[...this.#entries.values()]
				.filter((entry) => entry.accountId === accountId)
				.map((entry) => this.#cleanup(entry)),
		);
		if (account.acceptances > 0) await account.drained;
		account.phase = "retired";
	}
	reactivateAccount(incarnation: string, accountId: string): void {
		if (
			this.#phase !== "open" ||
			this.#incarnation !== incarnation ||
			!ID.test(accountId)
		)
			throw new Error("Vault-image Account reactivation is invalid");
		const previous = this.#accounts.get(accountId);
		if (previous === undefined || previous.phase !== "retired")
			throw new Error("Vault-image Account generation is not retired");
		this.#accounts.set(accountId, accountState(previous.generation + 1));
	}
	async retireRuntime(incarnation: string): Promise<void> {
		if (this.#incarnation !== incarnation)
			throw new Error("Vault-image Runtime retirement is invalid");
		this.#phase = "fenced";
		for (const account of this.#accounts.values())
			account.phase = "pendingRetirement";
		await this.#cleanupAll();
		await Promise.all(
			[...this.#accounts.values()]
				.filter((account) => account.acceptances > 0)
				.map((account) => account.drained),
		);
		this.#incarnation = undefined;
		for (const account of this.#accounts.values()) account.phase = "retired";
	}
	beginClose() {
		if (this.#phase !== "closed") this.#phase = "closing";
	}
	async drainClose() {
		this.beginClose();
		for (const account of this.#accounts.values())
			account.phase = "pendingRetirement";
		await this.#cleanupAll();
		await Promise.all([...this.#operations]);
		await Promise.all(
			[...this.#accounts.values()]
				.filter((account) => account.acceptances > 0)
				.map((account) => account.drained),
		);
		if (this.#entries.size !== 0)
			throw new Error("Vault-image source cleanup did not drain");
		this.#phase = "closed";
	}
	#capacity(add: number) {
		const identities =
			this.#entries.size +
			this.#tombstones.size +
			this.#accounts.size +
			(this.#incarnation === undefined ? 0 : 1);
		if (identities + add > MAX_VAULT_IMAGE_SOURCE_IDENTITIES)
			throw new Error("Vault-image source registry capacity exceeded");
	}
	async #enqueue<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
		if (this.#operations.size >= MAX_VAULT_IMAGE_SOURCE_IDENTITIES)
			throw new Error("Vault-image source in-flight capacity exceeded");
		const result = entry.tail.then(work, work);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		entry.tail = tail;
		this.#operations.add(result);
		try {
			return await result;
		} finally {
			this.#operations.delete(result);
		}
	}
	#cleanup(entry: Entry): Promise<void> {
		if (entry.cleanup !== undefined) return entry.cleanup;
		entry.state = "cleanupPending";
		// `close` is the cancellation primitive. Invoke it before waiting for the
		// serialized read tail so a provider whose read is held until close cannot
		// deadlock Runtime retirement.
		const closing = entry.source.close();
		const task = Promise.all([closing, entry.tail]).then(() =>
			this.#finishCleanup(entry),
		);
		entry.cleanup = task;
		task.catch(() => {
			if (entry.cleanup === task) entry.cleanup = undefined;
		});
		return task;
	}
	#isCleaning(entry: Entry): boolean {
		return entry.state === "cleanupPending";
	}
	async #cleanupFromOperation(entry: Entry) {
		entry.state = "cleanupPending";
		await entry.source.close();
		this.#finishCleanup(entry);
	}
	#finishCleanup(entry: Entry) {
		this.#entries.delete(entry.capabilityId);
		this.#tombstones.set(entry.capabilityId, {
			incarnation: entry.incarnation,
			accountId: entry.accountId,
			operationId: entry.operationId,
		});
	}
	async #cleanupAll() {
		await Promise.all(
			[...this.#entries.values()].map((entry) => this.#cleanup(entry)),
		);
	}
}
const acceptanceKey = (accountId: string, operationId: string) =>
	`${accountId.length}:${accountId}${operationId}`;
const accountState = (generation = 0): Account => {
	let notify: () => void = () => {};
	const drained = new Promise<void>((resolve) => {
		notify = resolve;
	});
	return { phase: "active", generation, acceptances: 0, drained, notify };
};
const randomIdentity = () => crypto.randomUUID();

export class WebVaultImageSourceExecutor {
	constructor(
		readonly request: (
			payload: unknown,
		) => Promise<{ controlResponseJson: string; binaryChunk?: Uint8Array }>,
		readonly runtimeIncarnation: string,
	) {
		if (!ID.test(runtimeIncarnation))
			throw new Error("Vault-image Runtime incarnation is invalid");
	}
	invoke(controlRequestJson: string) {
		return this.request({
			type: "vaultImageSource",
			runtimeIncarnation: this.runtimeIncarnation,
			controlRequestJson,
		});
	}
}
export function isVaultImageSourceHostRequest(value: unknown): value is {
	type: "vaultImageSource";
	runtimeIncarnation: string;
	controlRequestJson: string;
} {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Record<string, unknown>;
	return (
		Object.keys(request).sort().join("\0") ===
			["type", "runtimeIncarnation", "controlRequestJson"].sort().join("\0") &&
		request.type === "vaultImageSource" &&
		typeof request.runtimeIncarnation === "string" &&
		ID.test(request.runtimeIncarnation) &&
		typeof request.controlRequestJson === "string"
	);
}
