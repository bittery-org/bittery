export interface AtomicAttachmentDownloadSink {
	write(bytes: Uint8Array): Promise<void>;
	commit(): Promise<void>;
	discard(): Promise<void>;
}

export interface AttachmentDownloadSinkGrant {
	accountId: string;
	attachmentId: string;
	sink: AtomicAttachmentDownloadSink;
	expiresAt?: number;
}

type SinkEntry = AttachmentDownloadSinkGrant & {
	readonly capabilityId: string;
	readonly requestScope: string;
	readonly runtimeIncarnation: string;
	readonly accountGeneration: number;
	readonly runtimeGeneration: number;
	expiresAt: number;
	state: "granted" | "begun" | "finalizing" | "cleanupPending";
	tail: Promise<void>;
	cleanupTask?: Promise<void>;
};

type AccountState = {
	generation: number;
	pendingRetirement?: number;
};

type RuntimeState = {
	generation: number;
	activeIncarnation?: string;
	pendingIncarnation?: string;
	retiredIncarnation?: string;
	pendingRetirement?: number;
};

type SinkControl =
	| {
			type: "begin";
			accountId: string;
			attachmentId: string;
			capabilityId: string;
			requestScope: string;
	  }
	| { type: "write"; capabilityId: string }
	| { type: "commit"; capabilityId: string }
	| { type: "discard"; capabilityId: string }
	| { type: "retireAccount"; accountId: string }
	| { type: "completeAccountRetirement"; accountId: string }
	| { type: "retireRuntime" };

const CAPABILITY_ID_MAX_BYTES = 128;
const MAX_CAPABILITY_LIFETIME_MS = 60 * 60_000;
// This one budget covers every live sink owner and every replay tombstone. Backpressure is safer
// than evicting an identity whose successful cleanup acknowledgement may have been lost.
export const MAX_ATTACHMENT_DOWNLOAD_SINK_IDENTITIES = 1024;
const CAPABILITY_ID = /^[A-Za-z0-9._~-]+$/;
const answer = (type: string): string => JSON.stringify({ type });
const runtimeScopeOwners = new WeakMap<
	WebAttachmentDownloadSinkRegistry,
	{
		prepare(runtimeIncarnation: string): Promise<void>;
		commit(runtimeIncarnation: string): Promise<void>;
		owns(runtimeIncarnation: string): boolean;
	}
>();

function wipeBytes(bytes: Uint8Array | undefined): void {
	try {
		if (bytes?.buffer instanceof ArrayBuffer) {
			new Uint8Array(bytes.buffer).fill(0);
		} else {
			bytes?.fill(0);
		}
	} catch {
		// A transferred Worker buffer is already detached and contains no readable bytes.
	}
}

export function isCanonicalAttachmentDownloadCapabilityId(
	value: string,
): boolean {
	return (
		value.length > 0 &&
		value.length <= CAPABILITY_ID_MAX_BYTES &&
		CAPABILITY_ID.test(value)
	);
}

function parseControl(value: unknown): SinkControl | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const control = value as Record<string, unknown>;
	const keys = Object.keys(control).sort();
	if (
		control.type === "begin" &&
		keys.join("\0") ===
			["accountId", "attachmentId", "capabilityId", "requestScope", "type"]
				.sort()
				.join("\0") &&
		[
			control.accountId,
			control.attachmentId,
			control.capabilityId,
			control.requestScope,
		].every((candidate) => typeof candidate === "string")
	)
		return control as SinkControl;
	if (
		["write", "commit", "discard"].includes(String(control.type)) &&
		keys.join("\0") === ["capabilityId", "type"].join("\0") &&
		typeof control.capabilityId === "string"
	)
		return control as SinkControl;
	if (
		["retireAccount", "completeAccountRetirement"].includes(
			String(control.type),
		) &&
		keys.join("\0") === ["accountId", "type"].sort().join("\0") &&
		typeof control.accountId === "string" &&
		control.accountId.length > 0
	)
		return control as SinkControl;
	if (control.type === "retireRuntime" && keys.join("\0") === "type")
		return control as SinkControl;
	return undefined;
}

export class WebAttachmentDownloadSinkRegistry {
	readonly #entries = new Map<string, SinkEntry>();
	readonly #cleanedCapabilities = new Map<string, string>();
	readonly #now: () => number;
	readonly #identity: () => string;
	readonly #defaultLifetimeMs: number;
	readonly #operations = new Set<Promise<unknown>>();
	readonly #accountStates = new Map<string, AccountState>();
	readonly #runtimeState: RuntimeState = { generation: 0 };
	#phase: "uninitialized" | "open" | "fenced" | "closing" | "closed" =
		"uninitialized";
	#activationTask: Promise<void> | undefined;
	#closeTask: Promise<void> | undefined;

	constructor(
		options: {
			now?: () => number;
			identity?: () => string;
			defaultLifetimeMs?: number;
		} = {},
	) {
		this.#now = options.now ?? Date.now;
		this.#defaultLifetimeMs = options.defaultLifetimeMs ?? 5 * 60_000;
		this.#identity = options.identity ?? randomIdentity;
		const now = this.#now();
		if (
			!Number.isFinite(now) ||
			!Number.isFinite(this.#defaultLifetimeMs) ||
			this.#defaultLifetimeMs <= 0 ||
			this.#defaultLifetimeMs > MAX_CAPABILITY_LIFETIME_MS
		)
			throw new Error("Attachment Download sink lifetime is invalid");
		runtimeScopeOwners.set(this, {
			prepare: (runtimeIncarnation) =>
				this.#prepareRuntimeIncarnation(runtimeIncarnation),
			commit: (runtimeIncarnation) =>
				this.#commitRuntimeIncarnation(runtimeIncarnation),
			owns: (runtimeIncarnation) =>
				this.#runtimeState.activeIncarnation === runtimeIncarnation ||
				this.#runtimeState.pendingIncarnation === runtimeIncarnation ||
				this.#runtimeState.retiredIncarnation === runtimeIncarnation,
		});
	}

	async #prepareRuntimeIncarnation(runtimeIncarnation: string): Promise<void> {
		if (
			this.#phase === "closing" ||
			this.#phase === "closed" ||
			!isCanonicalAttachmentDownloadCapabilityId(runtimeIncarnation)
		)
			throw new Error("Runtime incarnation identity is invalid");
		if (
			this.#phase === "open" &&
			runtimeIncarnation === this.#runtimeState.activeIncarnation
		)
			return;
		if (runtimeIncarnation === this.#runtimeState.pendingIncarnation) return;
		if (
			this.#runtimeState.activeIncarnation !== undefined ||
			this.#runtimeState.pendingIncarnation !== undefined
		)
			throw new Error("Runtime incarnation activation was not retired");
		if (this.#activationTask !== undefined) {
			await this.#activationTask;
			return this.#prepareRuntimeIncarnation(runtimeIncarnation);
		}
		const ownsRuntimeStateSlot =
			this.#runtimeState.retiredIncarnation !== undefined ||
			this.#runtimeState.pendingRetirement !== undefined;
		this.#assertIdentityCapacity(ownsRuntimeStateSlot ? 0 : 1);
		this.#runtimeState.retiredIncarnation = undefined;
		this.#runtimeState.pendingIncarnation = runtimeIncarnation;
		this.#phase = "fenced";
		const prepare = Promise.all(
			[...this.#entries.values()].map((entry) => this.#scheduleCleanup(entry)),
		).then(() => undefined);
		this.#activationTask = prepare;
		try {
			await prepare;
		} finally {
			if (this.#activationTask === prepare) this.#activationTask = undefined;
		}
	}

	async #commitRuntimeIncarnation(runtimeIncarnation: string): Promise<void> {
		if (
			this.#phase === "open" &&
			runtimeIncarnation === this.#runtimeState.activeIncarnation
		)
			return;
		if (this.#activationTask !== undefined) await this.#activationTask;
		if (
			this.#phase !== "fenced" ||
			this.#runtimeState.pendingIncarnation !== runtimeIncarnation
		)
			throw new Error("Runtime incarnation activation was fenced");
		this.#runtimeState.activeIncarnation = runtimeIncarnation;
		this.#runtimeState.retiredIncarnation = undefined;
		this.#cleanedCapabilities.clear();
		this.#accountStates.clear();
		this.#runtimeState.pendingIncarnation = undefined;
		this.#phase = "open";
	}

	grant(grant: AttachmentDownloadSinkGrant): string {
		if (
			this.#phase !== "open" ||
			this.#runtimeState.pendingRetirement !== undefined ||
			this.#accountStates.get(grant.accountId)?.pendingRetirement !==
				undefined ||
			grant.accountId.length === 0 ||
			grant.attachmentId.length === 0 ||
			this.#runtimeState.activeIncarnation === undefined
		) {
			throw new Error("Attachment Download sink grant is invalid");
		}
		void this.#sweepExpiredUntouchedGrants()?.catch(() => undefined);
		const accountState = this.#accountStates.get(grant.accountId);
		this.#assertIdentityCapacity(accountState === undefined ? 2 : 1);
		const capabilityId = this.#identity();
		if (
			!isCanonicalAttachmentDownloadCapabilityId(capabilityId) ||
			this.#entries.has(capabilityId) ||
			this.#cleanedCapabilities.has(capabilityId)
		) {
			throw new Error(
				"Attachment Download sink capability identity is invalid",
			);
		}
		const now = this.#now();
		const expiresAt = grant.expiresAt ?? now + this.#defaultLifetimeMs;
		if (
			!Number.isFinite(now) ||
			!Number.isFinite(expiresAt) ||
			expiresAt <= now ||
			expiresAt - now > MAX_CAPABILITY_LIFETIME_MS
		)
			throw new Error("Attachment Download sink expiry is invalid");
		const retainedAccountState = accountState ?? { generation: 0 };
		if (accountState === undefined)
			this.#accountStates.set(grant.accountId, retainedAccountState);
		this.#entries.set(capabilityId, {
			...grant,
			capabilityId,
			requestScope: capabilityId,
			runtimeIncarnation: this.#runtimeState.activeIncarnation,
			accountGeneration: retainedAccountState.generation,
			runtimeGeneration: this.#runtimeState.generation,
			expiresAt,
			state: "granted",
			tail: Promise.resolve(),
		});
		return capabilityId;
	}

	async invoke(
		controlRequestJson: string,
		binaryChunk?: Uint8Array,
		runtimeIncarnation = "",
	): Promise<string> {
		try {
			return await this.#invoke(
				controlRequestJson,
				binaryChunk,
				runtimeIncarnation,
			);
		} finally {
			wipeBytes(binaryChunk);
		}
	}

	async #invoke(
		controlRequestJson: string,
		binaryChunk: Uint8Array | undefined,
		runtimeIncarnation: string,
	): Promise<string> {
		if (!isCanonicalAttachmentDownloadCapabilityId(runtimeIncarnation))
			return answer("invariantViolation");
		let control: SinkControl;
		try {
			const parsed = parseControl(JSON.parse(controlRequestJson));
			if (parsed === undefined) return answer("invariantViolation");
			control = parsed;
		} catch {
			return answer("invariantViolation");
		}
		const expirySweep = this.#sweepExpiredUntouchedGrants();
		if (expirySweep !== undefined) await expirySweep;
		if (
			control.type === "retireAccount" ||
			control.type === "completeAccountRetirement" ||
			control.type === "retireRuntime"
		) {
			const ownsActiveScope =
				runtimeIncarnation === this.#runtimeState.activeIncarnation;
			const ownsPendingScope =
				control.type === "retireRuntime" &&
				runtimeIncarnation === this.#runtimeState.pendingIncarnation;
			const ownsRetiredScope =
				control.type === "retireRuntime" &&
				runtimeIncarnation === this.#runtimeState.retiredIncarnation;
			if (
				binaryChunk !== undefined ||
				(!ownsActiveScope && !ownsPendingScope && !ownsRetiredScope)
			)
				return answer("invariantViolation");
			try {
				if (control.type === "retireAccount")
					await this.#retireAccount(control.accountId);
				else if (control.type === "completeAccountRetirement") {
					this.#completeAccountRetirement(control.accountId);
					return answer("retirementCompleted");
				} else await this.#retireRuntime(runtimeIncarnation);
				return answer("retired");
			} catch {
				return answer("sinkFailure");
			}
		}
		if (!isCanonicalAttachmentDownloadCapabilityId(control.capabilityId))
			return answer("invariantViolation");
		if (
			binaryChunk !== undefined &&
			(!(binaryChunk.buffer instanceof ArrayBuffer) ||
				binaryChunk.byteOffset !== 0 ||
				binaryChunk.byteLength !== binaryChunk.buffer.byteLength)
		)
			return answer("invariantViolation");
		const entry = this.#entries.get(control.capabilityId);
		if (entry === undefined) {
			return control.type === "discard" &&
				this.#cleanedCapabilities.get(control.capabilityId) ===
					runtimeIncarnation
				? answer("discarded")
				: answer("invariantViolation");
		}
		if (entry.state === "cleanupPending") {
			if (
				control.type !== "discard" ||
				runtimeIncarnation !== entry.runtimeIncarnation
			)
				return answer("invariantViolation");
			try {
				await (entry.cleanupTask ?? this.#scheduleCleanup(entry));
				return answer("discarded");
			} catch {
				return answer("sinkFailure");
			}
		}
		if (this.#phase !== "open" && control.type !== "discard")
			return answer("invariantViolation");
		return this.#enqueue(entry, async () => {
			if (
				(entry.state === "cleanupPending" && control.type !== "discard") ||
				(this.#phase !== "open" && control.type !== "discard")
			)
				return answer("invariantViolation");
			const now = this.#now();
			if (!Number.isFinite(now) || entry.expiresAt <= now) {
				try {
					entry.state = "cleanupPending";
					await this.#cleanupDirect(entry);
				} catch {
					return answer("sinkFailure");
				}
				return answer("invariantViolation");
			}
			if (control.type === "begin") {
				if (
					entry.state !== "granted" ||
					control.accountId !== entry.accountId ||
					control.attachmentId !== entry.attachmentId ||
					control.requestScope !== entry.requestScope ||
					runtimeIncarnation !== entry.runtimeIncarnation ||
					binaryChunk !== undefined
				)
					return answer("invariantViolation");
				entry.state = "begun";
				return answer("begun");
			}
			if (
				(control.type === "discard"
					? entry.state !== "granted" &&
						entry.state !== "begun" &&
						entry.state !== "cleanupPending"
					: entry.state !== "begun") ||
				runtimeIncarnation !== entry.runtimeIncarnation
			)
				return answer("invariantViolation");
			if (control.type === "write") {
				if (binaryChunk === undefined) return answer("invariantViolation");
				try {
					await entry.sink.write(binaryChunk);
					return answer("written");
				} catch {
					return answer("sinkFailure");
				}
			}
			if (binaryChunk !== undefined) return answer("invariantViolation");
			if (control.type === "discard") {
				try {
					entry.state = "cleanupPending";
					await this.#cleanupDirect(entry);
					return answer("discarded");
				} catch {
					return answer("sinkFailure");
				}
			}
			entry.state = "finalizing";
			try {
				await entry.sink.commit();
				this.#entries.delete(entry.capabilityId);
				this.#cleanedCapabilities.set(
					entry.capabilityId,
					entry.runtimeIncarnation,
				);
				this.#releaseAccountGeneration(entry.accountId);
				return answer("committed");
			} catch {
				try {
					entry.state = "cleanupPending";
					await this.#cleanupDirect(entry);
				} catch {
					// The retained cleanup-pending entry remains the sole owner.
				}
				return answer("sinkFailure");
			}
		});
	}

	async #retireAccount(accountId: string): Promise<void> {
		let state = this.#accountStates.get(accountId);
		let target = state?.pendingRetirement;
		if (target === undefined) {
			if (state === undefined) this.#assertIdentityCapacity(1);
			const current = state?.generation ?? 0;
			if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER)
				throw new Error("Attachment Download Account generation is exhausted");
			target = current + 1;
			state = { generation: current, pendingRetirement: target };
			this.#accountStates.set(accountId, state);
		}
		if (state === undefined)
			throw new Error("Attachment Download Account retirement is invalid");
		await Promise.all(
			[...this.#entries.values()]
				.filter(
					(entry) =>
						entry.accountId === accountId && entry.accountGeneration < target,
				)
				.map((entry) => this.#scheduleCleanup(entry)),
		);
		if (state.pendingRetirement === target) {
			state.generation = target;
		}
	}

	#completeAccountRetirement(accountId: string): void {
		const state = this.#accountStates.get(accountId);
		if (state?.pendingRetirement === undefined)
			throw new Error("Attachment Download Account retirement is not pending");
		state.pendingRetirement = undefined;
		this.#releaseAccountGeneration(accountId);
	}

	async #retireRuntime(runtimeIncarnation: string): Promise<void> {
		if (runtimeIncarnation === this.#runtimeState.retiredIncarnation) return;
		const terminalPhase =
			this.#phase === "closing" || this.#phase === "closed"
				? this.#phase
				: undefined;
		if (terminalPhase === undefined) this.#phase = "fenced";
		let target = this.#runtimeState.pendingRetirement;
		if (target === undefined) {
			if (
				!Number.isSafeInteger(this.#runtimeState.generation) ||
				this.#runtimeState.generation >= Number.MAX_SAFE_INTEGER
			)
				throw new Error("Attachment Download Runtime generation is exhausted");
			target = this.#runtimeState.generation + 1;
			this.#runtimeState.pendingRetirement = target;
		}
		await Promise.all(
			[...this.#entries.values()]
				.filter((entry) => entry.runtimeGeneration < target)
				.map((entry) => this.#scheduleCleanup(entry)),
		);
		if (this.#runtimeState.pendingRetirement === target) {
			this.#runtimeState.generation = target;
			this.#runtimeState.pendingRetirement = undefined;
		}
		this.#runtimeState.retiredIncarnation = runtimeIncarnation;
		if (runtimeIncarnation === this.#runtimeState.pendingIncarnation)
			this.#runtimeState.pendingIncarnation = undefined;
		if (runtimeIncarnation === this.#runtimeState.activeIncarnation)
			this.#runtimeState.activeIncarnation = undefined;
		if (this.#phase !== "closing" && this.#phase !== "closed")
			this.#phase = terminalPhase ?? "uninitialized";
		for (const accountId of [...this.#accountStates.keys()])
			this.#releaseAccountGeneration(accountId);
	}

	beginClose(): void {
		if (this.#phase !== "closed") this.#phase = "closing";
	}

	close(): Promise<void> {
		this.beginClose();
		if (this.#closeTask !== undefined) return this.#closeTask;
		if (this.#operations.size > 0) {
			return Promise.reject(
				new Error("Attachment Download sink close requires an external drain"),
			);
		}
		return this.drainClose();
	}

	drainClose(): Promise<void> {
		this.beginClose();
		if (this.#closeTask !== undefined) return this.#closeTask;
		const cleanups = [...this.#entries.values()].map((entry) =>
			this.#scheduleCleanup(entry),
		);
		const close = Promise.all([...this.#operations, ...cleanups]).then(() => {
			this.#phase = "closed";
		});
		this.#closeTask = close;
		void close.catch(() => {
			if (this.#closeTask === close) this.#closeTask = undefined;
		});
		return this.#closeTask;
	}

	#enqueue<T>(entry: SinkEntry, operation: () => Promise<T>): Promise<T> {
		if (this.#operations.size >= MAX_ATTACHMENT_DOWNLOAD_SINK_IDENTITIES)
			return Promise.reject(
				new Error("Attachment Download sink operation capacity is exhausted"),
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

	#scheduleCleanup(entry: SinkEntry, retainReplay = true): Promise<void> {
		if (entry.cleanupTask !== undefined) return entry.cleanupTask;
		entry.state = "cleanupPending";
		const cleanup = this.#enqueue(entry, () =>
			this.#runCleanup(entry, retainReplay),
		);
		entry.cleanupTask = cleanup;
		void cleanup.catch(() => {
			if (entry.cleanupTask === cleanup) entry.cleanupTask = undefined;
		});
		return cleanup;
	}

	async #cleanupDirect(entry: SinkEntry, retainReplay = true): Promise<void> {
		entry.state = "cleanupPending";
		const cleanup = this.#runCleanup(entry, retainReplay);
		entry.cleanupTask = cleanup;
		try {
			await cleanup;
		} catch (error) {
			if (entry.cleanupTask === cleanup) entry.cleanupTask = undefined;
			throw error;
		}
	}

	async #runCleanup(entry: SinkEntry, retainReplay = true): Promise<void> {
		if (this.#entries.get(entry.capabilityId) !== entry) return;
		await entry.sink.discard();
		this.#entries.delete(entry.capabilityId);
		if (retainReplay)
			this.#cleanedCapabilities.set(
				entry.capabilityId,
				entry.runtimeIncarnation,
			);
		this.#releaseAccountGeneration(entry.accountId);
	}

	#sweepExpiredUntouchedGrants(): Promise<void> | undefined {
		const now = this.#now();
		if (!Number.isFinite(now)) return undefined;
		const expired = [...this.#entries.values()].filter(
			(entry) => entry.state === "granted" && entry.expiresAt <= now,
		);
		if (expired.length === 0) return undefined;
		// Claim cleanup ownership synchronously so repeated sweeps cannot enqueue another task for
		// the same expired capability before this turn yields.
		return Promise.all(
			expired.map((entry) => this.#scheduleCleanup(entry, false)),
		).then(() => undefined);
	}

	#releaseAccountGeneration(accountId: string): void {
		if (
			this.#accountStates.get(accountId)?.pendingRetirement === undefined &&
			![...this.#entries.values()].some(
				(entry) => entry.accountId === accountId,
			)
		)
			this.#accountStates.delete(accountId);
	}

	#identityUsage(): number {
		const hasRuntimeState =
			this.#runtimeState.activeIncarnation !== undefined ||
			this.#runtimeState.pendingIncarnation !== undefined ||
			this.#runtimeState.retiredIncarnation !== undefined ||
			this.#runtimeState.pendingRetirement !== undefined;
		return (
			this.#entries.size +
			this.#cleanedCapabilities.size +
			this.#accountStates.size +
			(hasRuntimeState ? 1 : 0)
		);
	}

	#assertIdentityCapacity(additional: number): void {
		if (
			this.#identityUsage() + additional >
			MAX_ATTACHMENT_DOWNLOAD_SINK_IDENTITIES
		)
			throw new Error("Attachment Download sink capacity is exhausted");
	}
}

/** Internal owner capability; unlike the registry object, this is not exported by the package. */
export function activateWebAttachmentDownloadRuntimeIncarnation(
	registry: WebAttachmentDownloadSinkRegistry,
	runtimeIncarnation: string,
): Promise<void> {
	const owner = runtimeScopeOwners.get(registry);
	if (owner === undefined)
		throw new Error("Attachment Download owner is invalid");
	return owner
		.prepare(runtimeIncarnation)
		.then(() => owner.commit(runtimeIncarnation));
}

export function prepareWebAttachmentDownloadRuntimeIncarnation(
	registry: WebAttachmentDownloadSinkRegistry,
	runtimeIncarnation: string,
): Promise<void> {
	const owner = runtimeScopeOwners.get(registry);
	if (owner === undefined)
		throw new Error("Attachment Download owner is invalid");
	return owner.prepare(runtimeIncarnation);
}

export function commitWebAttachmentDownloadRuntimeIncarnation(
	registry: WebAttachmentDownloadSinkRegistry,
	runtimeIncarnation: string,
): Promise<void> {
	const owner = runtimeScopeOwners.get(registry);
	if (owner === undefined)
		throw new Error("Attachment Download owner is invalid");
	return owner.commit(runtimeIncarnation);
}

export function ownsWebAttachmentDownloadRuntimeIncarnation(
	registry: WebAttachmentDownloadSinkRegistry,
	runtimeIncarnation: string,
): boolean {
	return runtimeScopeOwners.get(registry)?.owns(runtimeIncarnation) ?? false;
}

function randomIdentity(): string {
	const id = globalThis.crypto?.randomUUID?.();
	if (id === undefined) throw new Error("Sink capability identity unavailable");
	return id;
}

export class WebAttachmentDownloadSinkExecutor {
	readonly #request: (payload: unknown) => Promise<string>;
	readonly #runtimeIncarnation: string;

	constructor(
		request: (payload: unknown) => Promise<string>,
		runtimeIncarnation: string,
	) {
		if (!isCanonicalAttachmentDownloadCapabilityId(runtimeIncarnation)) {
			throw new Error("Runtime incarnation identity unavailable");
		}
		this.#request = request;
		this.#runtimeIncarnation = runtimeIncarnation;
	}

	async invoke(
		controlRequestJson: string,
		binaryChunk?: Uint8Array,
	): Promise<string> {
		try {
			return await this.#request({
				type: "attachmentDownloadSink",
				runtimeIncarnation: this.#runtimeIncarnation,
				controlRequestJson,
				...(binaryChunk === undefined ? {} : { binaryChunk }),
			});
		} finally {
			wipeBytes(binaryChunk);
		}
	}
}

export function isAttachmentDownloadSinkRuntimeScopeRequest(
	value: unknown,
): value is {
	type: "attachmentDownloadSinkRuntimeScope";
	runtimeIncarnation: string;
	phase: "prepare" | "commit";
} {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<string, unknown>).type ===
			"attachmentDownloadSinkRuntimeScope" &&
		isCanonicalAttachmentDownloadCapabilityId(
			(value as Record<string, unknown>).runtimeIncarnation as string,
		) &&
		["prepare", "commit"].includes(
			(value as Record<string, unknown>).phase as string,
		) &&
		Object.keys(value).sort().join("\0") ===
			["phase", "runtimeIncarnation", "type"].sort().join("\0")
	);
}

export function isAttachmentDownloadSinkHostRequest(value: unknown): value is {
	type: "attachmentDownloadSink";
	runtimeIncarnation: string;
	controlRequestJson: string;
	binaryChunk?: Uint8Array;
} {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Record<string, unknown>;
	const keys = Object.keys(request).sort().join("\0");
	return (
		(keys ===
			["controlRequestJson", "runtimeIncarnation", "type"].sort().join("\0") ||
			keys ===
				["binaryChunk", "controlRequestJson", "runtimeIncarnation", "type"]
					.sort()
					.join("\0")) &&
		request.type === "attachmentDownloadSink" &&
		typeof request.runtimeIncarnation === "string" &&
		isCanonicalAttachmentDownloadCapabilityId(request.runtimeIncarnation) &&
		typeof request.controlRequestJson === "string" &&
		(request.binaryChunk === undefined ||
			request.binaryChunk instanceof Uint8Array)
	);
}

export function isAttachmentDownloadSinkCleanupHostRequest(
	value: unknown,
): value is {
	type: "attachmentDownloadSink";
	runtimeIncarnation: string;
	controlRequestJson: string;
} {
	if (
		!isAttachmentDownloadSinkHostRequest(value) ||
		value.binaryChunk !== undefined
	)
		return false;
	try {
		const type = parseControl(JSON.parse(value.controlRequestJson))?.type;
		return [
			"discard",
			"retireAccount",
			"completeAccountRetirement",
			"retireRuntime",
		].includes(type ?? "");
	} catch {
		return false;
	}
}
