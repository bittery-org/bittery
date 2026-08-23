/**
 * The platform-neutral host binding: typed calls over the generated protocol, and stores
 * over the generated projections. Everything a host needs above the wire lives here, so a
 * Worker, a Tauri bridge, and an MV3 port differ only in the {@link RuntimeTransport} they
 * supply. Nothing in this entrypoint imports React.
 */

import type {
	ItemsProjection,
	LoginItemDraft,
	ObservationRequest,
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
import type { RuntimeStore } from "./store";
import { RuntimeRequestError, type RuntimeTransport } from "./transport";

export { DEFAULT_RELEASE_GRACE_MS, type Schedule } from "./registry";
export type {
	RuntimeSnapshot,
	RuntimeStore,
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
	createLoginItem(
		input: CreateLoginItemInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	/** The Items observation for one Account. The same Account returns the same store. */
	items(accountId: string): RuntimeStore<ItemsProjection>;
	/** One Account's status, or the Device aggregate when no Account is named. */
	status(accountId?: string | null): RuntimeStore<RuntimeStatusProjection>;
	close(): Promise<void>;
}

export interface RuntimeClientOptions {
	transport: RuntimeTransport;
	schedule?: Schedule;
	releaseGraceMs?: number;
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
			return { accountId, userId };
		},
		async quickUnlock(input, callOptions) {
			const { accountId, userId } = await call(
				{ type: "quickUnlock", ...input },
				"signedIn",
				callOptions,
			);
			return { accountId, userId };
		},
		async createLoginItem(input, callOptions) {
			const { operationId, itemId, replicaRevision } = await call(
				{ type: "createLoginItem", ...input },
				"accepted",
				callOptions,
			);
			return { operationId, itemId, replicaRevision };
		},
		items(accountId) {
			return registry.store<ItemsProjection>({
				type: "items",
				accountId,
			} satisfies ObservationRequest);
		},
		status(accountId) {
			return registry.store<RuntimeStatusProjection>({
				type: "runtimeStatus",
				accountId: accountId ?? null,
			} satisfies ObservationRequest);
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
