import type { VaultImageSourceControlRequest } from "../generated/vault-image-control/contract";
import { validateVaultImageSourceControlRequest } from "../generated/vault-image-control/validator";
import {
	inspectUint8ArrayIntrinsic,
	isFullOwnedUint8Array,
	wipeBinaryIntrinsic,
} from "./binary-intrinsics";
import {
	type WebVaultCapabilityScope,
	WebVaultCapabilityScopes,
} from "./web-vault-capability-scopes";

export interface AtomicVaultImageSource {
	read(maxBytes: number): Promise<Uint8Array | null>;
	close(): Promise<void>;
}
export interface VaultImageSourceGrant {
	scope: WebVaultCapabilityScope;
	accountId: string;
	/** Create drafts omit both; Update selections may prebind the Vault before Core names an Operation. */
	operationId?: string;
	vaultId?: string;
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
	scope: WebVaultCapabilityScope;
	vaultId?: string;
	incarnation: string;
	accountId: string;
	operationId?: string;
};
type Account = {
	phase: "active" | "pendingRetirement" | "retired";
	generation: number;
};
type Acceptance = {
	accountId: string;
	vaultId: string;
	scope: WebVaultCapabilityScope;
	drained: Promise<void>;
	release(): void;
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
	readonly #scopes = new WebVaultCapabilityScopes({
		reserve: (additional) => this.#capacity(additional),
	});
	readonly #operations = new Set<Promise<unknown>>();
	readonly #acceptances = new Map<string, Acceptance>();
	readonly #now: () => number;
	readonly #identity: () => string;
	readonly #lifetime: number;
	#incarnation?: string;
	#retiredIncarnation?: string;
	#transition = {};
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
			const transition = {};
			this.#transition = transition;
			this.#phase = "fenced";
			await this.#cleanupAll();
			await Promise.all(
				[...this.#acceptances.values()].map((owner) => owner.drained),
			);
			if (this.#transition !== transition)
				throw new Error("Vault-image activation was superseded");
			if (this.#entries.size !== 0)
				throw new Error("Vault-image source cleanup did not drain");
			this.#incarnation = incarnation;
			this.#retiredIncarnation = undefined;
			this.#accounts.clear();
			this.#scopes.reset();
			this.#tombstones.clear();
			this.#phase = "open";
		});
	}
	captureScope(accountId: string, vaultId?: string): WebVaultCapabilityScope {
		if (
			this.#phase !== "open" ||
			this.#incarnation === undefined ||
			(this.#accounts.has(accountId) &&
				this.#accounts.get(accountId)?.phase !== "active")
		)
			throw new Error("Vault-image selection owner is retired");
		const missingAccount = !this.#accounts.has(accountId);
		const scope = this.#scopes.capture(
			accountId,
			vaultId,
			missingAccount ? 1 : 0,
		);
		if (missingAccount) this.#accounts.set(accountId, accountState());
		return scope;
	}
	async retireVaults(
		incarnation: string,
		accountId: string,
		vaultIds: string[],
	): Promise<void> {
		this.#requireCurrentOwner(incarnation);
		this.#scopes.retire(accountId, vaultIds);
		const targets = new Set(vaultIds);
		// Cleanup owns every admitted read tail and calls close before waiting. Retirement intent
		// stays in the shared epoch owner even if this particular awaiter disappears.
		await Promise.all([
			...[...this.#entries.values()]
				.filter(
					(entry) =>
						entry.accountId === accountId &&
						entry.vaultId !== undefined &&
						targets.has(entry.vaultId),
				)
				.map((entry) => this.#cleanup(entry)),
			...[...this.#acceptances.values()]
				.filter(
					(entry) =>
						entry.accountId === accountId && targets.has(entry.vaultId),
				)
				.map((entry) => entry.drained),
		]);
	}
	completeVaultRetirement(
		incarnation: string,
		accountId: string,
		vaultIds: string[],
	): void {
		this.#requireCurrentOwner(incarnation);
		if (
			this.#accounts.has(accountId) &&
			this.#accounts.get(accountId)?.phase !== "active"
		)
			throw new Error("Vault-image Account remains retired");
		const targets = new Set(
			vaultIds.filter((vault) => this.#scopes.isRetired(accountId, vault)),
		);
		if (
			[...this.#entries.values()].some(
				(entry) =>
					entry.accountId === accountId &&
					entry.vaultId !== undefined &&
					targets.has(entry.vaultId),
			) ||
			[...this.#acceptances.values()].some(
				(entry) => entry.accountId === accountId && targets.has(entry.vaultId),
			)
		)
			throw new Error("Vault-image retirement has not drained");
		this.#scopes.complete(accountId, vaultIds);
	}
	forgetAccountVaultRetirements(incarnation: string, accountId: string): void {
		this.#requireCurrentOwner(incarnation);
		if (
			this.#accounts.get(accountId)?.phase !== "retired" ||
			[...this.#entries.values()].some(
				(entry) => entry.accountId === accountId,
			) ||
			[...this.#acceptances.values()].some(
				(entry) => entry.accountId === accountId,
			)
		)
			throw new Error("Vault-image Account retirement has not drained");
		this.#scopes.forgetAccount(accountId);
	}
	#requireCurrentOwner(incarnation: string): void {
		if (this.#phase !== "open" || this.#incarnation !== incarnation)
			throw new Error("Vault-image Runtime is retired");
	}
	grant(grant: VaultImageSourceGrant): string {
		if (
			this.#phase !== "open" ||
			this.#incarnation === undefined ||
			!ID.test(grant.accountId) ||
			(grant.operationId !== undefined && grant.vaultId === undefined) ||
			!this.#scopes.matches(grant.scope, grant.accountId, grant.vaultId) ||
			(grant.operationId !== undefined && !ID.test(grant.operationId)) ||
			(grant.vaultId !== undefined && !ID.test(grant.vaultId)) ||
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
	async discard(capabilityId: string): Promise<void> {
		if (!ID.test(capabilityId))
			throw new Error("Vault-image capability is invalid");
		const entry = this.#entries.get(capabilityId);
		if (entry !== undefined) await this.#cleanup(entry);
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
		if (
			request.type === "retireRuntime" &&
			this.#retiredIncarnation === incarnation
		)
			return { type: "retired" };
		const canCompleteClosingHandshake =
			(request.type === "endAcceptance" || request.type === "retireRuntime") &&
			(this.#phase === "fenced" || this.#phase === "closing");
		if (
			!ID.test(incarnation) ||
			this.#incarnation !== incarnation ||
			(this.#phase !== "open" && !canCompleteClosingHandshake)
		)
			return { type: "sourceFailure" };
		if (
			request.type === "retireVaults" ||
			request.type === "completeVaultRetirement" ||
			request.type === "forgetAccountVaultRetirements"
		) {
			try {
				if (request.type === "retireVaults")
					await this.retireVaults(
						incarnation,
						request.accountId,
						request.vaultIds,
					);
				else if (request.type === "completeVaultRetirement")
					this.completeVaultRetirement(
						incarnation,
						request.accountId,
						request.vaultIds,
					);
				else this.forgetAccountVaultRetirements(incarnation, request.accountId);
				return { type: "retired" };
			} catch {
				return { type: "sourceFailure" };
			}
		}
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
			if (this.#acceptances.has(acceptance))
				return { type: "invariantViolation" };
			const release = this.beginAcceptance(
				incarnation,
				request.accountId,
				request.operationId,
			);
			if (release === undefined) return { type: "sourceFailure" };
			return { type: "acceptanceBegun" };
		}
		if (request.type === "endAcceptance") {
			const acceptance = acceptanceKey(request.accountId, request.operationId);
			const owner = this.#acceptances.get(acceptance);
			// A completed release may be replayed after its acknowledgment was lost.
			// The Runtime incarnation and phase fences above still apply.
			owner?.release();
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
				!this.#scopes.matches(entry.scope, entry.accountId, entry.vaultId) ||
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
					request.contentType !== entry.contentType ||
					request.byteLength !== entry.byteLength.toString()
				)
					return { type: "sourceFailure" };
				if (
					(entry.operationId !== undefined &&
						request.operationId !== entry.operationId) ||
					(entry.vaultId !== undefined && request.vaultId !== entry.vaultId)
				)
					return { type: "sourceFailure" };
				let scope: WebVaultCapabilityScope;
				try {
					scope = this.captureScope(entry.accountId, request.vaultId);
				} catch {
					return { type: "cancelled" };
				}
				entry.scope = scope;
				entry.operationId = request.operationId;
				entry.vaultId = request.vaultId;
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
				!this.#scopes.matches(entry.scope, entry.accountId, entry.vaultId) ||
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
		const key = acceptanceKey(accountId, operationId);
		const account = this.#accounts.get(accountId);
		const source = [...this.#tombstones.values()].find(
			(owner) =>
				owner.incarnation === incarnation &&
				owner.accountId === accountId &&
				owner.operationId === operationId &&
				owner.vaultId !== undefined &&
				this.#scopes.matches(owner.scope, accountId, owner.vaultId),
		);
		if (
			this.#phase !== "open" ||
			this.#incarnation !== incarnation ||
			account?.phase !== "active" ||
			source?.vaultId === undefined ||
			this.#acceptances.has(key)
		)
			return undefined;
		let finish = () => {};
		const drained = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let done = false;
		const release = () => {
			if (done) return;
			done = true;
			this.#acceptances.delete(key);
			finish();
		};
		this.#acceptances.set(key, {
			accountId,
			vaultId: source.vaultId,
			scope: source.scope,
			drained,
			release,
		});
		return release;
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
		const current = this.#accounts.get(accountId);
		this.#capacity(current === undefined ? 1 : 0);
		const account = current ?? accountState();
		if (account.phase === "active") this.#scopes.invalidateAccount(accountId);
		this.#accounts.set(accountId, account);
		account.phase = "pendingRetirement";
		await Promise.all(
			[...this.#entries.values()]
				.filter((entry) => entry.accountId === accountId)
				.map((entry) => this.#cleanup(entry)),
		);
		await Promise.all(
			[...this.#acceptances.values()]
				.filter((owner) => owner.accountId === accountId)
				.map((owner) => owner.drained),
		);
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
		if (this.#retiredIncarnation === incarnation) return;
		if (this.#incarnation !== incarnation)
			throw new Error("Vault-image Runtime retirement is invalid");
		const transition = {};
		this.#transition = transition;
		if (this.#phase !== "closing" && this.#phase !== "closed")
			this.#phase = "fenced";
		for (const account of this.#accounts.values())
			account.phase = "pendingRetirement";
		await this.#cleanupAll();
		await Promise.all(
			[...this.#acceptances.values()].map((owner) => owner.drained),
		);
		if (this.#transition !== transition) return;
		this.#incarnation = undefined;
		this.#retiredIncarnation = incarnation;
		for (const account of this.#accounts.values()) account.phase = "retired";
	}
	beginClose() {
		if (this.#phase !== "closed") {
			this.#transition = {};
			this.#phase = "closing";
		}
	}
	async drainClose() {
		this.beginClose();
		for (const account of this.#accounts.values())
			account.phase = "pendingRetirement";
		await this.#cleanupAll();
		await Promise.all([...this.#operations]);
		await Promise.all(
			[...this.#acceptances.values()].map((owner) => owner.drained),
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
			this.#scopes.size +
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
			scope: entry.scope,
			vaultId: entry.vaultId,
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
const accountState = (generation = 0): Account => ({
	phase: "active",
	generation,
});
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
