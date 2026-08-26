/**
 * The platform-neutral host binding: typed calls over the generated protocol, and stores
 * over the generated projections. Everything a host needs above the wire lives here, so a
 * Worker, a Tauri bridge, and an MV3 port differ only in the {@link RuntimeTransport} they
 * supply. Nothing in this entrypoint imports React.
 */

import type {
	CreateShareDraft,
	ItemsProjection,
	LoginItemDraft,
	ObservationRequest,
	PendingShareResultsProjection,
	RuntimeOutcome,
	RuntimeRequest,
	RuntimeResponse,
	RuntimeStatusProjection,
} from "../../generated/runtime-protocol/contract";
import {
	ObservationRegistry,
	type ObservationRegistryOptions,
	type Schedule,
} from "./registry";
import {
	type ActiveAccountStorage,
	createMemoryActiveAccountStorage,
	RuntimeSession,
	type RuntimeSessionSnapshot,
} from "./session";
import type { RuntimeStore, Subscribable } from "./store";
import { RuntimeRequestError, type RuntimeTransport } from "./transport";

export { DEFAULT_RELEASE_GRACE_MS, type Schedule } from "./registry";
export {
	ACTIVE_ACCOUNT_STORAGE_KEY,
	type ActiveAccountStorage,
	createMemoryActiveAccountStorage,
	createWebActiveAccountStorage,
	deriveSession,
	LOADING_SESSION,
	RuntimeSession,
	type RuntimeSessionSnapshot,
	type RuntimeSessionState,
	reconcileAccount,
	type WebStorageLike,
} from "./session";
export {
	IDLE_SNAPSHOT,
	type RuntimeSnapshot,
	type RuntimeStore,
	type Subscribable,
} from "./store";
export {
	RuntimeRequestError,
	type RuntimeTransport,
	transportErrorCode,
} from "./transport";

export type RuntimeSignedIn = Omit<
	Extract<RuntimeResponse, { type: "signedIn" }>,
	"type"
>;
export type RuntimeAccessChanged = Omit<
	Extract<RuntimeResponse, { type: "accessChanged" }>,
	"type"
>;
export type RuntimeAccepted = Omit<
	Extract<RuntimeResponse, { type: "accepted" }>,
	"type"
>;
export type SignInInput = Omit<
	Extract<RuntimeRequest, { type: "signIn" }>,
	"type"
>;
export type QuickUnlockInput = Omit<
	Extract<RuntimeRequest, { type: "quickUnlock" }>,
	"type"
>;
export interface CreateLoginItemInput {
	accountId: string;
	vaultId: string;
	draft: LoginItemDraft;
}
export interface CreateShareInput {
	accountId: string;
	itemId: string;
	draft: CreateShareDraft;
}

export interface AcknowledgeShareResultInput {
	accountId: string;
	operationId: string;
}

export type RuntimeShareResultAcknowledged = Omit<
	Extract<RuntimeResponse, { type: "shareResultAcknowledged" }>,
	"type"
>;

export interface RuntimeCallOptions {
	signal?: AbortSignal;
}

export interface RuntimeClient {
	signIn(
		input: SignInInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeSignedIn>;
	quickUnlock(
		input: QuickUnlockInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeSignedIn>;
	/**
	 * Retires live access but keeps what a password-only unlock needs. Both this and
	 * {@link RuntimeClient.signOut} answer the access state the Device now holds, and an
	 * unknown Account answers `signedOut` rather than failing, so a teardown path never has
	 * to handle an error it cannot act on.
	 */
	lock(
		accountId: string,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccessChanged>;
	/** Retires access and forgets the Quick Unlock material and Session with it. */
	signOut(
		accountId: string,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccessChanged>;
	createLoginItem(
		input: CreateLoginItemInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	createShare(
		input: CreateShareInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	acknowledgeShareResult(
		input: AcknowledgeShareResultInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeShareResultAcknowledged>;
	/** The Items observation for one Account. The same Account returns the same store. */
	items(accountId: string): RuntimeStore<ItemsProjection>;
	/** Durable, Account-scoped Share results waiting for host delivery acknowledgement. */
	pendingShareResults(
		accountId: string,
	): RuntimeStore<PendingShareResultsProjection>;
	/** One Account's status, or the Device aggregate when no Account is named. */
	status(accountId?: string | null): RuntimeStore<RuntimeStatusProjection>;
	/**
	 * The Device session: one Device-wide status observation reconciled against the host's
	 * active-Account pointer. Open it once at the composition root and never tear it down —
	 * `status(accountId)` answers `ACCOUNT_MISSING` for an uninstalled Account, while the
	 * Device-wide form survives sign-in, sign-out, lock, and Account switch.
	 */
	session(): Subscribable<RuntimeSessionSnapshot>;
	/** Moves the host's active-Account pointer. A UI selection, never Runtime scope. */
	selectAccount(accountId: string | null): void;
	/** The Account an action applies to; an explicit offer outranks the stored pointer. */
	resolveAccount(preferred?: string | null): string | null;
	close(): Promise<void>;
}

export interface RuntimeClientOptions {
	transport: RuntimeTransport;
	schedule?: Schedule;
	releaseGraceMs?: number;
	/** Where the active-Account pointer lives. In memory when the host supplies none. */
	activeAccount?: ActiveAccountStorage;
}

let clients = 0;

export function createRuntimeClient(
	options: RuntimeClientOptions,
): RuntimeClient {
	const transport = options.transport;
	const registry = new ObservationRegistry(
		options satisfies ObservationRegistryOptions,
	);
	clients += 1;
	const prefix = `client-${clients}`;
	let requests = 0;
	const session = new RuntimeSession(
		registry.store<RuntimeStatusProjection>({
			type: "runtimeStatus",
			accountId: null,
		} satisfies ObservationRequest),
		options.activeAccount ?? createMemoryActiveAccountStorage(),
	);

	async function call<Variant extends RuntimeResponse["type"]>(
		request: RuntimeRequest,
		expected: Variant,
		callOptions: RuntimeCallOptions | undefined,
	): Promise<Extract<RuntimeResponse, { type: Variant }>> {
		requests += 1;
		const responseJson = await transport.request(
			`${prefix}-request-${requests}`,
			JSON.stringify(request),
			callOptions,
		);
		const response = decodeOutcome(responseJson);
		if (response.type !== expected) {
			throw new RuntimeRequestError(
				"INVARIANT_VIOLATION",
				`The Runtime answered ${request.type} with ${response.type}`,
			);
		}
		return response as Extract<RuntimeResponse, { type: Variant }>;
	}

	return {
		async signIn(input, callOptions) {
			const { accountId, userId } = await call(
				{ type: "signIn", ...input },
				"signedIn",
				callOptions,
			);
			// The Account a ceremony just installed is the one the host is looking at.
			session.select(accountId);
			return { accountId, userId };
		},
		async quickUnlock(input, callOptions) {
			const { accountId, userId } = await call(
				{ type: "quickUnlock", ...input },
				"signedIn",
				callOptions,
			);
			session.select(accountId);
			return { accountId, userId };
		},
		async lock(accountId, callOptions) {
			const answer = await call(
				{ type: "lock", accountId },
				"accessChanged",
				callOptions,
			);
			return { accountId: answer.accountId, access: answer.access };
		},
		async signOut(accountId, callOptions) {
			const answer = await call(
				{ type: "signOut", accountId },
				"accessChanged",
				callOptions,
			);
			return { accountId: answer.accountId, access: answer.access };
		},
		async createLoginItem(input, callOptions) {
			const { operationId, itemId, replicaRevision } = await call(
				{ type: "createLoginItem", ...input },
				"accepted",
				callOptions,
			);
			return { operationId, itemId, replicaRevision };
		},
		async createShare(input, callOptions) {
			const { operationId, itemId, replicaRevision } = await call(
				{ type: "createShare", ...input },
				"accepted",
				callOptions,
			);
			return { operationId, itemId, replicaRevision };
		},
		async acknowledgeShareResult(input, callOptions) {
			const { accountId, operationId } = await call(
				{ type: "acknowledgeShareResult", ...input },
				"shareResultAcknowledged",
				callOptions,
			);
			return { accountId, operationId };
		},
		items(accountId) {
			return registry.store<ItemsProjection>({
				type: "items",
				accountId,
			} satisfies ObservationRequest);
		},
		pendingShareResults(accountId) {
			return registry.store<PendingShareResultsProjection>({
				type: "pendingShareResults",
				accountId,
			} satisfies ObservationRequest);
		},
		status(accountId) {
			return registry.store<RuntimeStatusProjection>({
				type: "runtimeStatus",
				accountId: accountId ?? null,
			} satisfies ObservationRequest);
		},
		session() {
			return session.store;
		},
		selectAccount(accountId) {
			session.select(accountId);
		},
		resolveAccount(preferred) {
			return session.resolve(preferred);
		},
		close() {
			return transport.close();
		},
	};
}

/**
 * Unwraps the declared outcome envelope. A failure becomes a typed error carrying its code;
 * the Rust `message` never becomes the thrown `message`, so it cannot reach a person.
 */
export function decodeOutcome(responseJson: string): RuntimeResponse {
	let outcome: RuntimeOutcome;
	try {
		outcome = JSON.parse(responseJson) as RuntimeOutcome;
	} catch {
		throw new RuntimeRequestError(
			"INVARIANT_VIOLATION",
			"The Runtime answered with text that is not the outcome envelope",
		);
	}
	if (outcome.type === "failed") {
		throw new RuntimeRequestError(outcome.value.code, outcome.value.message);
	}
	return outcome.value;
}
