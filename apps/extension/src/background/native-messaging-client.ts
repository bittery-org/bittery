import {
	IncompleteLifecycleOutcomeError,
	type LifecycleOutcome,
	requireCompleteLifecycleOutcome,
} from "@bittery/core/services/account-lifecycle";
import type { MaterialFailureCleanup } from "@bittery/core/services/material-publication";
import { NATIVE_HOST_NAME } from "./constants";
import {
	DESKTOP_PROTOCOL_VERSION,
	type DesktopEnvelope,
	type DesktopEventPayload,
	DesktopProtocolMismatchError,
	type DesktopRequest,
	type DesktopResponse,
} from "./desktop-protocol";

const REQUEST_TIMEOUT_MS = 30000;
const RECONNECT_DELAY_MS = 1000;

type PendingRequest = {
	resolve: (value: DesktopResponse) => void;
	reject: (reason?: unknown) => void;
	timeoutId: ReturnType<typeof setTimeout>;
	generation: number;
};

export class RetiredNativeDeliveryError extends Error {
	constructor() {
		super("Native delivery retired");
	}
}

type NativeMessagingClientDeps = {
	connectNative?: typeof chrome.runtime.connectNative;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDesktopResponseEnvelope(
	value: unknown,
): value is DesktopEnvelope<DesktopResponse> {
	return (
		isRecord(value) &&
		(value.protocolVersion === undefined ||
			typeof value.protocolVersion === "number") &&
		typeof value.type === "string" &&
		(value.requestId === undefined || typeof value.requestId === "string")
	);
}

function isDesktopEventPayload(value: unknown): value is DesktopEventPayload {
	if (!isRecord(value) || !isRecord(value.payload)) {
		return false;
	}

	switch (value.event) {
		case "lock":
			return (
				typeof value.payload.reason === "string" &&
				typeof value.payload.timestamp === "number"
			);
		case "unlock":
			return (
				Array.isArray(value.payload.accounts) &&
				value.payload.accounts.every(
					(account) => typeof account === "string",
				) &&
				typeof value.payload.timestamp === "number"
			);
		case "desktop_close":
			return typeof value.payload.timestamp === "number";
		case "active_account_changed":
			return (
				typeof value.payload.accountId === "string" &&
				typeof value.payload.timestamp === "number"
			);
		case "theme_changed":
			return (
				(value.payload.theme === "light" ||
					value.payload.theme === "dark" ||
					value.payload.theme === "system") &&
				typeof value.payload.timestamp === "number"
			);
		default:
			return false;
	}
}

function getDefaultConnectNative(): typeof chrome.runtime.connectNative {
	return (application: string) => {
		if (!globalThis.chrome?.runtime?.connectNative) {
			throw new Error("chrome.runtime.connectNative is unavailable");
		}

		return globalThis.chrome.runtime.connectNative(application);
	};
}

function affectedAfterCleanup(
	outcome: LifecycleOutcome,
	requestedAccountId: string,
): readonly string[] {
	const affected = outcome.affected.map((account) => account.accountId);
	// A failed pre-state read can leave C1 without an affected list, although
	// its per-Account cleanup still ran. A clean unknown target is a no-op.
	return affected.length > 0 || outcome.failures.length === 0
		? affected
		: [requestedAccountId];
}

export class NativeMessagingClient {
	private readonly connectNativeImpl: typeof chrome.runtime.connectNative;
	private port: chrome.runtime.Port | null = null;
	private pendingRequests = new Map<string, PendingRequest>();
	private desktopEventListeners = new Set<
		(event: DesktopEventPayload) => void
	>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private subscribedToDesktopEvents = false;
	private protocolMismatchDetected = false;
	private requestCounter = 0;
	private deliveryGeneration = 0;
	private retirement: Promise<void> | null = null;
	private retirementCleanup:
		| ((event: DesktopEventPayload | null) => Promise<void>)
		| null = null;
	private retireProjection: ((accountIds?: readonly string[]) => void) | null =
		null;
	private deliveryRetiredListeners = new Set<() => void>();
	private activeMutations = new Set<Promise<void>>();
	private activeFailureCleanups = new Set<Promise<void>>();
	private materialTails = new Map<string, Promise<void>>();
	private retainedMaterial = new Set<string>();
	private publicationEpochs = new Map<string, number>();
	private nextPublicationEpoch = 0;
	private materialInvocations = new Map<
		symbol,
		{
			accountId: string;
			generation: number;
			publicationEpoch: number;
			dirty: boolean;
		}
	>();
	private pendingRetirements: Array<DesktopEventPayload | null> = [];
	private materialDrain: Promise<void> | null = null;
	private releaseRetirement: (() => void) | null = null;
	private failRetirement: ((reason: unknown) => void) | null = null;
	private lifecycleCleanups: Promise<void> = Promise.resolve();
	private lifecycleFailed = false;

	constructor(deps: NativeMessagingClientDeps = {}) {
		this.connectNativeImpl = deps.connectNative ?? getDefaultConnectNative();
	}

	configureRetirementCleanup(
		cleanup: (event: DesktopEventPayload | null) => Promise<void>,
	): void {
		this.retirementCleanup = cleanup;
	}

	/** The shared Account/Vault projection follows every admitted C1 cleanup. */
	configureProjectionRetirement(
		retire: (accountIds?: readonly string[]) => void,
	): void {
		this.retireProjection = retire;
	}

	onDeliveryRetired(listener: () => void): () => void {
		this.deliveryRetiredListeners.add(listener);
		return () => this.deliveryRetiredListeners.delete(listener);
	}

	currentDeliveryGeneration(): number {
		return this.deliveryGeneration;
	}
	hasRetirementCleanup(): boolean {
		return this.retirementCleanup !== null;
	}

	retireObservedStatus(
		status: { locked: boolean; timestamp: number } | null,
	): Promise<void> {
		if (status?.locked && this.retirement) return this.retirement;
		this.retireDelivery(
			status
				? {
						event: "lock",
						payload: {
							reason: "Core status locked",
							timestamp: status.timestamp,
						},
					}
				: { event: "desktop_close", payload: { timestamp: Date.now() } },
		);
		return this.retirement ?? Promise.resolve();
	}

	async captureDeliveryGeneration(): Promise<number> {
		if (this.retirement) await this.retirement;
		if (this.lifecycleFailed) throw new RetiredNativeDeliveryError();
		return this.deliveryGeneration;
	}

	isCurrentDelivery(generation: number): boolean {
		return (
			generation === this.deliveryGeneration &&
			this.retirement === null &&
			!this.lifecycleFailed
		);
	}

	assertCurrentDelivery(generation: number): void {
		if (!this.isCurrentDelivery(generation))
			throw new RetiredNativeDeliveryError();
	}

	/** Mark a possible write before calling a material setter. A fulfilled
	 * mutation publishes unless its result says no new material was installed. */
	async withMaterialMutation<T>(
		generation: number,
		accountId: string,
		mutate: (check: () => void, markMaterialWrite: () => void) => Promise<T>,
		invocation?: symbol,
		published: (result: T) => boolean = () => true,
	): Promise<T> {
		return this.withAccountMaterialMutation(
			generation,
			accountId,
			mutate,
			true,
			invocation,
			published,
		);
	}

	/** Local Account writes join the same drain without becoming native-origin
	 * retained material. A local publication still supersedes older native failure
	 * cleanup for this Account. */
	async withLocalMaterialMutation<T>(
		generation: number,
		accountId: string,
		mutate: (check: () => void) => Promise<T>,
		published: (result: T) => boolean = () => true,
	): Promise<T> {
		return this.withAccountMaterialMutation(
			generation,
			accountId,
			(check) => mutate(check),
			false,
			undefined,
			published,
		);
	}

	private async withAccountMaterialMutation<T>(
		generation: number,
		accountId: string,
		mutate: (check: () => void, markMaterialWrite: () => void) => Promise<T>,
		nativeOrigin: boolean,
		invocation?: symbol,
		published: (result: T) => boolean = () => true,
	): Promise<T> {
		this.assertCurrentDelivery(generation);
		const previous = this.materialTails.get(accountId) ?? Promise.resolve();
		let release!: () => void;
		const finished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => finished);
		this.materialTails.set(accountId, tail);
		await previous;
		try {
			this.assertCurrentDelivery(generation);
			const wasRetained = this.retainedMaterial.has(accountId);
			const publicationEpoch = this.publicationEpochs.get(accountId) ?? 0;
			if (invocation) {
				this.materialInvocations.set(invocation, {
					accountId,
					generation,
					publicationEpoch,
					dirty: false,
				});
			}
			const markMaterialWrite = () => {
				if (!nativeOrigin) return;
				// A setter may partially write and then reject. Retirement owns that
				// dirty material even before publication is acknowledged.
				this.retainedMaterial.add(accountId);
				const current = invocation
					? this.materialInvocations.get(invocation)
					: undefined;
				if (current) current.dirty = true;
			};
			this.activeMutations.add(finished);
			const result = await mutate(
				() => this.assertCurrentDelivery(generation),
				markMaterialWrite,
			);
			this.assertCurrentDelivery(generation);
			if (published(result)) {
				const nextEpoch = ++this.nextPublicationEpoch;
				if (nativeOrigin) this.retainedMaterial.add(accountId);
				else this.retainedMaterial.delete(accountId);
				this.publicationEpochs.set(accountId, nextEpoch);
				if (invocation) {
					this.materialInvocations.set(invocation, {
						accountId,
						generation,
						publicationEpoch: nextEpoch,
						dirty: true,
					});
				}
			} else {
				if (wasRetained) this.retainedMaterial.add(accountId);
				else this.retainedMaterial.delete(accountId);
				if (invocation) this.materialInvocations.delete(invocation);
			}
			return result;
		} finally {
			this.activeMutations.delete(finished);
			release();
			if (this.materialTails.get(accountId) === tail)
				this.materialTails.delete(accountId);
		}
	}

	newMaterialInvocation(): symbol {
		return Symbol("native material invocation");
	}

	completeMaterialInvocation(invocation: symbol): void {
		this.materialInvocations.delete(invocation);
	}

	/** Snapshot the Account's material publication before remote policy work. */
	captureMaterialFailureCleanup(
		generation: number,
		accountId: string,
	): MaterialFailureCleanup {
		this.assertCurrentDelivery(generation);
		const epoch = this.publicationEpochs.get(accountId) ?? 0;
		return {
			isCurrent: () => this.isCurrentCleanupEpoch(generation, accountId, epoch),
			run: (cleanup) =>
				this.withMaterialFailureCleanup(generation, accountId, epoch, cleanup),
		};
	}

	private isCurrentCleanupEpoch(
		generation: number,
		accountId: string,
		publicationEpoch: number,
	): boolean {
		return (
			this.isCurrentDelivery(generation) &&
			(this.publicationEpochs.get(accountId) ?? 0) === publicationEpoch
		);
	}

	/** A failed policy check may clear only the material it observed.
	 * The destructive C1 call joins the same Account tail and retirement drain. */
	private async withMaterialFailureCleanup(
		generation: number,
		accountId: string,
		publicationEpoch: number,
		cleanup: () => Promise<LifecycleOutcome>,
	): Promise<LifecycleOutcome | null> {
		if (!this.isCurrentDelivery(generation)) return null;
		const previous = this.materialTails.get(accountId) ?? Promise.resolve();
		let release!: () => void;
		const finished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => finished);
		this.materialTails.set(accountId, tail);
		await previous;
		try {
			if (!this.isCurrentCleanupEpoch(generation, accountId, publicationEpoch))
				return null;
			this.activeFailureCleanups.add(finished);
			let attempted: LifecycleOutcome | null = null;
			try {
				attempted = await cleanup();
				this.retireProjection?.(affectedAfterCleanup(attempted, accountId));
				const outcome = requireCompleteLifecycleOutcome(attempted, {
					operation: "Extension Travel failure lockAccount",
					requireAffected: true,
				});
				this.retainedMaterial.delete(accountId);
				this.publicationEpochs.delete(accountId);
				return outcome;
			} catch (error) {
				if (!attempted) this.retireProjection?.([accountId]);
				this.lifecycleFailed = true;
				this.fenceDelivery();
				this.failRetirement?.(error);
				throw error;
			} finally {
				this.activeFailureCleanups.delete(finished);
			}
		} finally {
			release();
			if (this.materialTails.get(accountId) === tail)
				this.materialTails.delete(accountId);
		}
	}

	async withOwnedFailureCleanup(
		generation: number,
		accountId: string,
		invocation: symbol,
		cleanup: () => Promise<LifecycleOutcome>,
	): Promise<void> {
		if (!this.isCurrentDelivery(generation)) {
			this.materialInvocations.delete(invocation);
			return;
		}
		const previous = this.materialTails.get(accountId) ?? Promise.resolve();
		let release!: () => void;
		const finished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => finished);
		this.materialTails.set(accountId, tail);
		await previous;
		try {
			const owned = this.materialInvocations.get(invocation);
			if (
				!this.isCurrentDelivery(generation) ||
				owned?.accountId !== accountId ||
				owned.generation !== generation ||
				!owned.dirty ||
				!this.retainedMaterial.has(accountId) ||
				(this.publicationEpochs.get(accountId) ?? 0) !== owned.publicationEpoch
			)
				return;
			this.activeFailureCleanups.add(finished);
			let attempted: LifecycleOutcome | null = null;
			try {
				attempted = await cleanup();
				this.retireProjection?.(affectedAfterCleanup(attempted, accountId));
				requireCompleteLifecycleOutcome(attempted, {
					operation: "Extension native biometric failure lockAccount",
					requireAffected: true,
				});
				this.retainedMaterial.delete(accountId);
				this.publicationEpochs.delete(accountId);
			} catch (error) {
				if (!attempted) this.retireProjection?.([accountId]);
				this.lifecycleFailed = true;
				this.fenceDelivery();
				this.failRetirement?.(error);
				throw error;
			} finally {
				this.activeFailureCleanups.delete(finished);
			}
		} finally {
			this.materialInvocations.delete(invocation);
			release();
			if (this.materialTails.get(accountId) === tail)
				this.materialTails.delete(accountId);
		}
	}

	/** C1 callers acquire the same fence; an event callback waits only for the
	 * material drain, never for its own final retirement acknowledgement. */
	async withLifecycleCleanup<T>(
		cleanup: () => Promise<T>,
		clearedMaterial?:
			| "all"
			| { accountId: string }
			| ((result: T) => readonly string[]),
		requestedAccountId?: string,
	): Promise<T> {
		if (this.lifecycleFailed) throw new RetiredNativeDeliveryError();
		const ownsFence = this.retirement === null;
		if (ownsFence) this.fenceDelivery();
		await this.materialDrain;
		const complete = this.lifecycleCleanups.then(cleanup);
		this.lifecycleCleanups = complete.then(
			() => undefined,
			() => {
				this.lifecycleFailed = true;
			},
		);
		let result: T;
		try {
			result = await complete;
		} catch (error) {
			const requested =
				requestedAccountId ??
				(typeof clearedMaterial === "object"
					? clearedMaterial.accountId
					: undefined);
			if (clearedMaterial === "all") {
				this.retireProjection?.();
			} else if (error instanceof IncompleteLifecycleOutcomeError) {
				this.retireProjection?.(
					requested
						? affectedAfterCleanup(error.outcome, requested)
						: error.outcome.affected.map((account) => account.accountId),
				);
			} else if (requested) {
				this.retireProjection?.([requested]);
			}
			// The event owner may have opened this fence before Sign out joined it.
			// Its final acknowledgement must retain the nested C1 failure too.
			this.lifecycleFailed = true;
			this.failRetirement?.(error);
			throw error;
		}
		if (clearedMaterial === "all") {
			this.retireProjection?.();
			this.retainedMaterial.clear();
			this.publicationEpochs.clear();
		} else if (typeof clearedMaterial === "function") {
			const accountIds = clearedMaterial(result);
			this.retireProjection?.(accountIds);
			for (const accountId of accountIds) {
				this.retainedMaterial.delete(accountId);
				this.publicationEpochs.delete(accountId);
			}
		} else if (clearedMaterial) {
			this.retireProjection?.([clearedMaterial.accountId]);
			this.retainedMaterial.delete(clearedMaterial.accountId);
			this.publicationEpochs.delete(clearedMaterial.accountId);
		}
		if (ownsFence) await this.finishRetirement();
		return result;
	}

	/** Material installed under the native delivery lease still needs C1 cleanup,
	 * even when the UI session has no Desktop owner. */
	needsMaterialCleanup(): boolean {
		return this.retainedMaterial.size > 0 && !this.lifecycleFailed;
	}

	private fenceDelivery(): void {
		this.deliveryGeneration += 1;
		if (this.retirement) return;
		this.retirement = new Promise<void>((resolve, reject) => {
			this.releaseRetirement = resolve;
			this.failRetirement = reject;
		});
		// Browser callbacks do not await this barrier; attach a handler while
		// retaining rejection for callers that do await acquisition.
		void this.retirement.catch(() => {});
		this.materialDrain = Promise.all([
			...this.activeMutations,
			...this.activeFailureCleanups,
		]).then(() => undefined);
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timeoutId);
			pending.reject(new RetiredNativeDeliveryError());
		}
		this.pendingRequests.clear();
		for (const listener of this.deliveryRetiredListeners) listener();
	}

	private async finishRetirement(): Promise<void> {
		for (;;) {
			while (this.pendingRetirements.length > 0) {
				const next = this.pendingRetirements.shift() ?? null;
				await this.retirementCleanup?.(next);
			}
			const cleanups = this.lifecycleCleanups;
			await cleanups;
			if (
				this.pendingRetirements.length === 0 &&
				this.lifecycleCleanups === cleanups
			)
				break;
		}
		// The serialized cleanup tail absorbs a rejection so later queued cleanup
		// can run. A failed lifecycle still cannot acknowledge this retirement.
		if (this.lifecycleFailed) return;
		this.materialDrain = null;
		this.retirement = null;
		this.releaseRetirement?.();
		this.releaseRetirement = null;
		this.failRetirement = null;
	}

	private retireDelivery(event: DesktopEventPayload | null): void {
		this.pendingRetirements.push(event);
		const ownsFence = this.retirement === null;
		this.fenceDelivery();
		if (!ownsFence) return;
		if (
			this.activeMutations.size === 0 &&
			this.activeFailureCleanups.size === 0 &&
			!this.retirementCleanup
		) {
			this.pendingRetirements.length = 0;
			this.materialDrain = null;
			this.retirement = null;
			this.releaseRetirement?.();
			this.releaseRetirement = null;
			this.failRetirement = null;
			return;
		}
		void (async () => {
			await this.materialDrain;
			await this.finishRetirement();
		})().catch((error) => {
			// Failed C1 cleanup keeps acquisition closed. Callers retain the failure.
			this.failRetirement?.(error);
			console.error(
				"[native-messaging-client] Native retirement cleanup failed:",
				error,
			);
		});
	}

	private nextRequestId(): string {
		this.requestCounter += 1;
		return `desktop-${Date.now()}-${this.requestCounter}`;
	}

	private ensurePort(): chrome.runtime.Port {
		if (this.port && !this.protocolMismatchDetected) {
			return this.port;
		}
		if (this.port) {
			const incompatiblePort = this.port;
			this.port = null;
			incompatiblePort.disconnect();
		}

		const port = this.connectNativeImpl(NATIVE_HOST_NAME);
		port.onMessage.addListener((message) => {
			if (this.port === port) this.handleMessage(message);
		});
		port.onDisconnect.addListener(() => {
			this.handleDisconnect(port);
		});
		this.port = port;
		this.protocolMismatchDetected = false;
		return port;
	}

	private handleMessage(message: unknown): void {
		if (!isDesktopResponseEnvelope(message)) {
			return;
		}
		if (message.protocolVersion !== DESKTOP_PROTOCOL_VERSION) {
			this.handleProtocolMismatch(message.protocolVersion);
			return;
		}
		if (message.type === "PROTOCOL_MISMATCH") {
			const receivedVersion =
				typeof message.receivedVersion === "number"
					? message.receivedVersion
					: undefined;
			const expectedVersion =
				typeof message.expectedVersion === "number"
					? message.expectedVersion
					: DESKTOP_PROTOCOL_VERSION;
			this.handleProtocolMismatch(receivedVersion, expectedVersion);
			return;
		}

		if (message.type === "DESKTOP_EVENT") {
			const event: unknown = message;
			if (!isDesktopEventPayload(event)) {
				return;
			}
			if (event.event === "lock" || event.event === "desktop_close") {
				this.retireDelivery(event);
			}
			if (event.event === "unlock" && this.retirement) {
				const port = this.port;
				void this.retirement.then(() => {
					if (this.port === port) {
						for (const listener of this.desktopEventListeners) listener(event);
					}
				});
				return;
			}
			for (const listener of this.desktopEventListeners) {
				listener(event);
			}
			return;
		}

		if (!message.requestId) {
			return;
		}

		const pending = this.pendingRequests.get(message.requestId);
		if (!pending) {
			return;
		}
		if (!this.isCurrentDelivery(pending.generation)) {
			this.pendingRequests.delete(message.requestId);
			clearTimeout(pending.timeoutId);
			pending.reject(new RetiredNativeDeliveryError());
			return;
		}

		clearTimeout(pending.timeoutId);
		this.pendingRequests.delete(message.requestId);
		pending.resolve(message);
	}

	private handleProtocolMismatch(
		receivedVersion: number | undefined,
		// Annotated, not inferred: the pinned version is a literal type now, and
		// the peer is entitled to name any version in a mismatch report.
		expectedVersion: number = DESKTOP_PROTOCOL_VERSION,
	): void {
		const error = new DesktopProtocolMismatchError(
			expectedVersion,
			receivedVersion,
		);
		console.error("[native-messaging-client] Desktop protocol mismatch", {
			expectedVersion: error.expectedVersion,
			receivedVersion: error.receivedVersion,
		});

		this.protocolMismatchDetected = true;
		this.subscribedToDesktopEvents = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timeoutId);
			pending.reject(error);
		}
		this.pendingRequests.clear();
		this.retireDelivery(null);
	}

	private handleDisconnect(disconnectedPort: chrome.runtime.Port): void {
		if (this.port !== disconnectedPort) {
			return;
		}

		const error = chrome.runtime.lastError;
		const reason = error?.message || "Native host disconnected";

		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timeoutId);
			pending.reject(new Error(`Native host disconnected: ${reason}`));
		}
		this.pendingRequests.clear();
		this.retireDelivery(null);
		this.port = null;
		this.subscribedToDesktopEvents = false;

		if (
			!this.protocolMismatchDetected &&
			this.desktopEventListeners.size > 0 &&
			!this.reconnectTimer
		) {
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null;
				void this.ensureDesktopEventSubscription();
			}, RECONNECT_DELAY_MS);
		}
	}

	request(
		message: DesktopRequest,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<DesktopResponse> {
		if (this.retirement)
			return this.retirement.then(() => this.request(message, timeoutMs));
		return new Promise((resolve, reject) => {
			let requestId: string | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			try {
				const port = this.ensurePort();
				const nextRequestId = this.nextRequestId();
				requestId = nextRequestId;
				timeoutId = setTimeout(() => {
					this.pendingRequests.delete(nextRequestId);
					reject(new Error("Native messaging timeout"));
				}, timeoutMs);

				this.pendingRequests.set(nextRequestId, {
					resolve,
					reject,
					timeoutId,
					generation: this.deliveryGeneration,
				});

				port.postMessage({
					requestId: nextRequestId,
					protocolVersion: DESKTOP_PROTOCOL_VERSION,
					...message,
				} satisfies DesktopEnvelope<DesktopRequest>);
			} catch (error) {
				if (requestId) {
					this.pendingRequests.delete(requestId);
				}
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				reject(error);
			}
		});
	}

	private async ensureDesktopEventSubscription(): Promise<void> {
		if (
			this.subscribedToDesktopEvents ||
			this.desktopEventListeners.size === 0
		) {
			return;
		}

		const response = await this.request({
			type: "SUBSCRIBE_DESKTOP_EVENTS",
		});
		if (response.type === "DESKTOP_EVENT_SUBSCRIPTION" && response.subscribed) {
			this.subscribedToDesktopEvents = true;
		}
	}

	private async maybeUnsubscribeDesktopEvents(): Promise<void> {
		if (
			!this.subscribedToDesktopEvents ||
			this.desktopEventListeners.size > 0
		) {
			return;
		}

		try {
			await this.request({
				type: "UNSUBSCRIBE_DESKTOP_EVENTS",
			});
		} finally {
			this.subscribedToDesktopEvents = false;
		}
	}

	subscribeToDesktopEvents(
		listener: (event: DesktopEventPayload) => void,
	): () => void {
		this.desktopEventListeners.add(listener);
		void this.ensureDesktopEventSubscription().catch((error) => {
			if (error instanceof DesktopProtocolMismatchError) {
				return;
			}
			console.error(
				"[native-messaging-client] Failed to subscribe to desktop events:",
				error,
			);
		});

		return () => {
			this.desktopEventListeners.delete(listener);
			void this.maybeUnsubscribeDesktopEvents().catch((error) => {
				console.error(
					"[native-messaging-client] Failed to unsubscribe from desktop events:",
					error,
				);
			});
		};
	}
}

export const nativeMessagingClient = new NativeMessagingClient();

export function sendNativeMessage(
	message: DesktopRequest,
): Promise<DesktopResponse> {
	return nativeMessagingClient.request(message);
}
