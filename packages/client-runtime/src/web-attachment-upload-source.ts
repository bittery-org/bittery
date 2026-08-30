import type { AttachmentUploadSourceControl as SourceControl } from "../generated/transfer-control/contract";
import { validateAttachmentUploadSourceControl } from "../generated/transfer-control/validator";
import {
	inspectUint8ArrayIntrinsic,
	isFullOwnedUint8Array,
	wipeBinaryIntrinsic,
} from "./binary-intrinsics";

export interface AtomicAttachmentUploadSource {
	read(maxBytes: number): Promise<Uint8Array | null>;
	close(): Promise<void>;
}

export interface AttachmentUploadSourceGrant {
	accountId: string;
	itemId: string;
	name: string;
	contentType: string;
	expectedBytes: bigint;
	source: AtomicAttachmentUploadSource;
	expiresAt?: number;
}

type Entry = AttachmentUploadSourceGrant & {
	capabilityId: string;
	runtimeIncarnation: string;
	runtimeGeneration: number;
	accountGeneration: number;
	expiresAt: number;
	state: "granted" | "claimed" | "cleanupPending";
	readBytes: bigint;
	tail: Promise<void>;
	cleanupTask?: Promise<void>;
};
type AccountState = { generation: number; pendingRetirement?: number };
type RuntimeState = {
	generation: number;
	active?: string;
	pending?: string;
	retired?: string;
	pendingRetirement?: number;
};
const MAX_LIFETIME_MS = 60 * 60_000;
export const MAX_ATTACHMENT_UPLOAD_SOURCE_IDENTITIES = 1024;
const ID = /^[A-Za-z0-9._~-]+$/;
const canonical = (value: string) =>
	value.length > 0 && value.length <= 128 && ID.test(value);
const answer = (type: string) => JSON.stringify({ type });
const runtimeOwners = new WeakMap<
	WebAttachmentUploadSourceRegistry,
	{
		prepare(value: string): Promise<void>;
		commit(value: string): Promise<void>;
		owns(value: string): boolean;
	}
>();

function parseControl(value: unknown): SourceControl | undefined {
	if (!validateAttachmentUploadSourceControl(value)) return undefined;
	if (
		(value.type === "retireAccount" ||
			value.type === "completeAccountRetirement") &&
		!canonical(value.accountId)
	)
		return undefined;
	return value;
}

export class WebAttachmentUploadSourceRegistry {
	readonly #entries = new Map<string, Entry>();
	readonly #tombstones = new Map<string, string>();
	readonly #accounts = new Map<string, AccountState>();
	readonly #runtime: RuntimeState = { generation: 0 };
	readonly #now: () => number;
	readonly #identity: () => string;
	readonly #lifetime: number;
	readonly #operations = new Set<Promise<unknown>>();
	#phase: "uninitialized" | "fenced" | "open" | "closing" | "closed" =
		"uninitialized";
	#activation?: Promise<void>;
	#closeTask?: Promise<void>;

	constructor(
		options: {
			now?: () => number;
			identity?: () => string;
			defaultLifetimeMs?: number;
		} = {},
	) {
		this.#now = options.now ?? Date.now;
		this.#identity = options.identity ?? randomIdentity;
		this.#lifetime = options.defaultLifetimeMs ?? 5 * 60_000;
		if (
			!Number.isFinite(this.#now()) ||
			!Number.isFinite(this.#lifetime) ||
			this.#lifetime <= 0 ||
			this.#lifetime > MAX_LIFETIME_MS
		)
			throw new Error("Attachment Upload source lifetime is invalid");
		runtimeOwners.set(this, {
			prepare: (value) => this.#prepare(value),
			commit: (value) => this.#commit(value),
			owns: (value) =>
				this.#runtime.active === value ||
				this.#runtime.pending === value ||
				this.#runtime.retired === value,
		});
	}

	async #prepare(value: string): Promise<void> {
		if (
			!canonical(value) ||
			this.#phase === "closing" ||
			this.#phase === "closed"
		)
			throw new Error("Invalid Runtime incarnation");
		if (this.#phase === "open" && this.#runtime.active === value) return;
		if (this.#runtime.pending === value) return;
		if (
			this.#runtime.active !== undefined ||
			this.#runtime.pending !== undefined
		)
			throw new Error("Runtime incarnation activation was not retired");
		if (this.#activation !== undefined) {
			await this.#activation;
			return this.#prepare(value);
		}
		this.#capacity(
			this.#runtime.retired !== undefined ||
				this.#runtime.pendingRetirement !== undefined
				? 0
				: 1,
		);
		this.#runtime.retired = undefined;
		this.#runtime.pending = value;
		this.#phase = "fenced";
		const task = Promise.all(
			[...this.#entries.values()].map((entry) => this.#scheduleCleanup(entry)),
		).then(() => undefined);
		this.#activation = task;
		try {
			await task;
		} finally {
			if (this.#activation === task) this.#activation = undefined;
		}
	}

	async #commit(value: string): Promise<void> {
		if (this.#phase === "open" && this.#runtime.active === value) return;
		if (this.#activation !== undefined) await this.#activation;
		if (this.#phase !== "fenced" || this.#runtime.pending !== value)
			throw new Error("Runtime incarnation activation was fenced");
		this.#runtime.active = value;
		this.#runtime.pending = undefined;
		this.#runtime.retired = undefined;
		this.#tombstones.clear();
		this.#accounts.clear();
		this.#phase = "open";
	}

	grant(grant: AttachmentUploadSourceGrant): string {
		if (
			this.#phase !== "open" ||
			this.#runtime.active === undefined ||
			this.#runtime.pendingRetirement !== undefined ||
			this.#accounts.get(grant.accountId)?.pendingRetirement !== undefined ||
			!canonical(grant.accountId) ||
			!canonical(grant.itemId) ||
			grant.name.trim().length === 0 ||
			grant.name.length > 255 ||
			grant.contentType.trim().length === 0 ||
			grant.contentType.length > 255 ||
			grant.expectedBytes <= 0n
		)
			throw new Error("Attachment Upload source grant is invalid");
		void this.#sweepExpired()?.catch(() => undefined);
		const account = this.#accounts.get(grant.accountId);
		this.#capacity(account === undefined ? 2 : 1);
		const capabilityId = this.#identity();
		if (
			!canonical(capabilityId) ||
			this.#entries.has(capabilityId) ||
			this.#tombstones.has(capabilityId)
		)
			throw new Error("Attachment Upload source identity is invalid");
		const now = this.#now();
		const expiresAt = grant.expiresAt ?? now + this.#lifetime;
		if (
			!Number.isFinite(now) ||
			!Number.isFinite(expiresAt) ||
			expiresAt <= now ||
			expiresAt - now > MAX_LIFETIME_MS
		)
			throw new Error("Attachment Upload source expiry is invalid");
		const retained = account ?? { generation: 0 };
		if (account === undefined) this.#accounts.set(grant.accountId, retained);
		this.#entries.set(capabilityId, {
			...grant,
			capabilityId,
			runtimeIncarnation: this.#runtime.active,
			runtimeGeneration: this.#runtime.generation,
			accountGeneration: retained.generation,
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
	): Promise<{ controlResponseJson: string; binaryChunk?: Uint8Array }> {
		let request: SourceControl;
		try {
			const parsed = parseControl(JSON.parse(controlJson));
			if (parsed === undefined)
				return { controlResponseJson: answer("invariantViolation") };
			request = parsed;
		} catch {
			return { controlResponseJson: answer("invariantViolation") };
		}
		if (
			request.type === "retireAccount" ||
			request.type === "completeAccountRetirement" ||
			request.type === "retireRuntime"
		) {
			const owns =
				incarnation === this.#runtime.active ||
				(request.type === "retireRuntime" &&
					(incarnation === this.#runtime.pending ||
						incarnation === this.#runtime.retired));
			if (!owns) return { controlResponseJson: answer("invariantViolation") };
			try {
				if (request.type === "retireRuntime")
					await this.#retireRuntime(incarnation);
				else {
					if (typeof request.accountId !== "string") throw new Error();
					if (request.type === "retireAccount")
						await this.#retireAccount(request.accountId);
					else {
						this.#completeAccountRetirement(request.accountId);
						return { controlResponseJson: answer("retirementCompleted") };
					}
				}
				return { controlResponseJson: answer("retired") };
			} catch {
				return { controlResponseJson: answer("sourceFailure") };
			}
		}
		await this.#sweepExpired()?.catch(() => undefined);
		if (!canonical(incarnation))
			return { controlResponseJson: answer("invariantViolation") };
		const id = request.capabilityId;
		if (typeof id !== "string" || !canonical(id))
			return { controlResponseJson: answer("invariantViolation") };
		const entry = this.#entries.get(id);
		if (entry === undefined)
			return {
				controlResponseJson:
					request.type === "close" && this.#tombstones.get(id) === incarnation
						? answer("closed")
						: answer("sourceFailure"),
			};
		if (request.type === "close") {
			if (
				entry.runtimeIncarnation !== incarnation ||
				entry.runtimeGeneration !== this.#runtime.generation ||
				this.#accounts.get(entry.accountId)?.generation !==
					entry.accountGeneration
			)
				return { controlResponseJson: answer("cancelled") };
			try {
				await this.#scheduleCleanup(entry);
				return { controlResponseJson: answer("closed") };
			} catch {
				return { controlResponseJson: answer("sourceFailure") };
			}
		}
		return this.#enqueue(entry, async () => {
			if (
				entry.runtimeIncarnation !== incarnation ||
				entry.runtimeGeneration !== this.#runtime.generation ||
				this.#accounts.get(entry.accountId)?.generation !==
					entry.accountGeneration ||
				this.#phase !== "open"
			)
				return { controlResponseJson: answer("cancelled") };
			if (entry.state === "cleanupPending")
				return { controlResponseJson: answer("sourceFailure") };
			const now = this.#now();
			if (!Number.isFinite(now) || entry.expiresAt <= now) {
				await this.#cleanupDirect(entry).catch(() => undefined);
				return { controlResponseJson: answer("sourceFailure") };
			}
			if (request.type === "claim") {
				if (
					entry.state !== "granted" ||
					entry.accountId !== request.accountId ||
					entry.itemId !== request.itemId ||
					entry.name !== request.name ||
					entry.contentType !== request.contentType ||
					entry.expectedBytes.toString() !== request.expectedBytes
				)
					return { controlResponseJson: answer("sourceFailure") };
				entry.state = "claimed";
				return { controlResponseJson: answer("claimed") };
			}
			if (request.type !== "read" || entry.state !== "claimed")
				return { controlResponseJson: answer("sourceFailure") };
			const maxBytes = request.maxBytes;
			if (
				typeof maxBytes !== "number" ||
				!Number.isSafeInteger(maxBytes) ||
				maxBytes < 1 ||
				maxBytes > 262_144
			)
				return { controlResponseJson: answer("sourceFailure") };
			let chunk: Uint8Array | null;
			try {
				chunk = await entry.source.read(maxBytes);
			} catch {
				return { controlResponseJson: answer("sourceFailure") };
			}
			if (chunk === null) return { controlResponseJson: answer("end") };
			const view = inspectUint8ArrayIntrinsic(chunk);
			if (
				view === undefined ||
				!view.hasOnlyIndexedOwnData ||
				!isFullOwnedUint8Array(view) ||
				view.byteLength === 0 ||
				view.byteLength > maxBytes
			) {
				wipeBinaryIntrinsic(chunk);
				return { controlResponseJson: answer("invariantViolation") };
			}
			entry.readBytes += BigInt(view.byteLength);
			if (entry.readBytes > entry.expectedBytes) {
				wipeBinaryIntrinsic(chunk);
				return { controlResponseJson: answer("sourceFailure") };
			}
			return { controlResponseJson: answer("chunk"), binaryChunk: chunk };
		});
	}

	async #retireAccount(accountId: string): Promise<void> {
		let state = this.#accounts.get(accountId);
		let target = state?.pendingRetirement;
		if (target === undefined) {
			if (state === undefined) this.#capacity(1);
			const current = state?.generation ?? 0;
			if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER)
				throw new Error("Account generation exhausted");
			target = current + 1;
			state = { generation: current, pendingRetirement: target };
			this.#accounts.set(accountId, state);
		}
		await Promise.all(
			[...this.#entries.values()]
				.filter(
					(entry) =>
						entry.accountId === accountId && entry.accountGeneration < target,
				)
				.map((entry) => this.#scheduleCleanup(entry)),
		);
		if (state !== undefined && state.pendingRetirement === target)
			state.generation = target;
	}

	#completeAccountRetirement(accountId: string): void {
		const state = this.#accounts.get(accountId);
		if (state?.pendingRetirement === undefined)
			throw new Error("Account retirement is not pending");
		state.pendingRetirement = undefined;
		this.#releaseAccount(accountId);
	}

	async #retireRuntime(incarnation: string): Promise<void> {
		if (this.#runtime.retired === incarnation) return;
		const terminalPhase =
			this.#phase === "closing" || this.#phase === "closed"
				? this.#phase
				: undefined;
		if (terminalPhase === undefined) this.#phase = "fenced";
		let target = this.#runtime.pendingRetirement;
		if (target === undefined) {
			if (
				!Number.isSafeInteger(this.#runtime.generation) ||
				this.#runtime.generation >= Number.MAX_SAFE_INTEGER
			)
				throw new Error("Runtime generation exhausted");
			target = this.#runtime.generation + 1;
			this.#runtime.pendingRetirement = target;
		}
		await Promise.all(
			[...this.#entries.values()]
				.filter((entry) => entry.runtimeGeneration < target)
				.map((entry) => this.#scheduleCleanup(entry)),
		);
		this.#runtime.generation = target;
		this.#runtime.pendingRetirement = undefined;
		this.#runtime.retired = incarnation;
		if (this.#runtime.active === incarnation) this.#runtime.active = undefined;
		if (this.#runtime.pending === incarnation)
			this.#runtime.pending = undefined;
		if (this.#phase !== "closing" && this.#phase !== "closed")
			this.#phase = terminalPhase ?? "uninitialized";
		for (const accountId of [...this.#accounts.keys()])
			this.#releaseAccount(accountId);
	}

	beginClose(): void {
		if (this.#phase !== "closed") this.#phase = "closing";
	}
	drainClose(): Promise<void> {
		this.beginClose();
		if (this.#closeTask !== undefined) return this.#closeTask;
		const task = Promise.all([
			...this.#operations,
			...[...this.#entries.values()].map((entry) =>
				this.#scheduleCleanup(entry),
			),
		]).then(() => {
			this.#phase = "closed";
		});
		this.#closeTask = task;
		void task.catch(() => {
			if (this.#closeTask === task) this.#closeTask = undefined;
		});
		return task;
	}

	#enqueue<T>(entry: Entry, operation: () => Promise<T>): Promise<T> {
		if (this.#operations.size >= MAX_ATTACHMENT_UPLOAD_SOURCE_IDENTITIES)
			return Promise.reject(
				new Error("Upload source operation capacity exhausted"),
			);
		const result = entry.tail.then(operation, operation);
		this.#operations.add(result);
		void result
			.finally(() => this.#operations.delete(result))
			.catch(() => undefined);
		entry.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	#scheduleCleanup(entry: Entry, replay = true): Promise<void> {
		if (entry.cleanupTask !== undefined) return entry.cleanupTask;
		entry.state = "cleanupPending";
		const prior = entry.tail;
		const close = Promise.resolve().then(() => entry.source.close());
		const task = Promise.all([prior, close]).then(() => {
			if (this.#entries.get(entry.capabilityId) !== entry) return;
			this.#entries.delete(entry.capabilityId);
			if (replay)
				this.#tombstones.set(entry.capabilityId, entry.runtimeIncarnation);
			this.#releaseAccount(entry.accountId);
		});
		entry.cleanupTask = task;
		void task.catch(() => {
			if (entry.cleanupTask === task) entry.cleanupTask = undefined;
		});
		return task;
	}
	async #cleanupDirect(entry: Entry, replay = true): Promise<void> {
		entry.state = "cleanupPending";
		const task = this.#runCleanup(entry, replay);
		entry.cleanupTask = task;
		try {
			await task;
		} catch (error) {
			if (entry.cleanupTask === task) entry.cleanupTask = undefined;
			throw error;
		}
	}
	async #runCleanup(entry: Entry, replay: boolean): Promise<void> {
		if (this.#entries.get(entry.capabilityId) !== entry) return;
		await entry.source.close();
		this.#entries.delete(entry.capabilityId);
		if (replay)
			this.#tombstones.set(entry.capabilityId, entry.runtimeIncarnation);
		this.#releaseAccount(entry.accountId);
	}
	#sweepExpired(): Promise<void> | undefined {
		const now = this.#now();
		if (!Number.isFinite(now)) return undefined;
		const expired = [...this.#entries.values()].filter(
			(entry) => entry.state === "granted" && entry.expiresAt <= now,
		);
		return expired.length === 0
			? undefined
			: Promise.all(expired.map((entry) => this.#scheduleCleanup(entry))).then(
					() => undefined,
				);
	}
	#releaseAccount(accountId: string): void {
		if (
			this.#accounts.get(accountId)?.pendingRetirement === undefined &&
			![...this.#entries.values()].some(
				(entry) => entry.accountId === accountId,
			)
		)
			this.#accounts.delete(accountId);
	}
	#capacity(additional: number): void {
		const runtime =
			this.#runtime.active !== undefined ||
			this.#runtime.pending !== undefined ||
			this.#runtime.retired !== undefined ||
			this.#runtime.pendingRetirement !== undefined;
		const used =
			this.#entries.size +
			this.#tombstones.size +
			this.#accounts.size +
			(runtime ? 1 : 0);
		if (used + additional > MAX_ATTACHMENT_UPLOAD_SOURCE_IDENTITIES)
			throw new Error("Attachment Upload source capacity exhausted");
	}
}

export function prepareWebAttachmentUploadRuntimeIncarnation(
	registry: WebAttachmentUploadSourceRegistry,
	incarnation: string,
): Promise<void> {
	const owner = runtimeOwners.get(registry);
	if (owner === undefined)
		throw new Error("Attachment Upload owner is invalid");
	return owner.prepare(incarnation);
}
export function commitWebAttachmentUploadRuntimeIncarnation(
	registry: WebAttachmentUploadSourceRegistry,
	incarnation: string,
): Promise<void> {
	const owner = runtimeOwners.get(registry);
	if (owner === undefined)
		throw new Error("Attachment Upload owner is invalid");
	return owner.commit(incarnation);
}
export function ownsWebAttachmentUploadRuntimeIncarnation(
	registry: WebAttachmentUploadSourceRegistry,
	incarnation: string,
): boolean {
	return runtimeOwners.get(registry)?.owns(incarnation) ?? false;
}
function randomIdentity(): string {
	const id = globalThis.crypto?.randomUUID?.();
	if (id === undefined)
		throw new Error("Source capability identity unavailable");
	return id;
}

export class WebAttachmentUploadSourceExecutor {
	constructor(
		readonly request: (
			payload: unknown,
		) => Promise<{ controlResponseJson: string; binaryChunk?: Uint8Array }>,
		readonly runtimeIncarnation: string,
	) {
		if (!canonical(runtimeIncarnation))
			throw new Error("Runtime incarnation identity unavailable");
	}
	invoke(controlRequestJson: string) {
		return this.request({
			type: "attachmentUploadSource",
			runtimeIncarnation: this.runtimeIncarnation,
			controlRequestJson,
		});
	}
}
export function isAttachmentUploadSourceHostRequest(value: unknown): value is {
	type: "attachmentUploadSource";
	runtimeIncarnation: string;
	controlRequestJson: string;
} {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Record<string, unknown>;
	return (
		Object.keys(request).sort().join("\0") ===
			["type", "runtimeIncarnation", "controlRequestJson"].sort().join("\0") &&
		request.type === "attachmentUploadSource" &&
		typeof request.runtimeIncarnation === "string" &&
		canonical(request.runtimeIncarnation) &&
		typeof request.controlRequestJson === "string"
	);
}
