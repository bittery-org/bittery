import type {
	RuntimeError,
	RuntimeErrorCode,
	RuntimeOutcome,
} from "@bittery/client-runtime/protocol";
import type { WorkerRuntime } from "@bittery/client-runtime/worker-runtime";

const RUNTIME_ACCOUNT_ID_KEY = "bittery_runtime_account_id";

type Listener = () => void;

let runtimeAccountId: string | null = readStoredRuntimeAccountId();
const listeners = new Set<Listener>();

function readStoredRuntimeAccountId(): string | null {
	if (typeof window === "undefined") {
		return null;
	}
	return window.localStorage.getItem(RUNTIME_ACCOUNT_ID_KEY);
}

export function getRuntimeAccountId(): string | null {
	return runtimeAccountId;
}

export function subscribeRuntimeAccount(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function setRuntimeAccountId(accountId: string | null): void {
	runtimeAccountId = accountId;
	if (typeof window !== "undefined") {
		if (accountId) {
			window.localStorage.setItem(RUNTIME_ACCOUNT_ID_KEY, accountId);
		} else {
			window.localStorage.removeItem(RUNTIME_ACCOUNT_ID_KEY);
		}
	}
	for (const listener of listeners) {
		listener();
	}
}

export function runtimeSignInRequestJson(input: {
	serverUrl: string;
	email: string;
	masterPassword: string;
	secretKey: string;
	insecureTransportConfirmed: boolean;
}): string {
	return JSON.stringify({
		type: "signIn",
		serverUrl: input.serverUrl,
		email: input.email,
		masterPassword: input.masterPassword,
		secretKey: input.secretKey,
		insecureTransportConfirmed: input.insecureTransportConfirmed,
	});
}

export function runtimeQuickUnlockRequestJson(input: {
	accountId: string;
	masterPassword: string;
}): string {
	return JSON.stringify({
		type: "quickUnlock",
		accountId: input.accountId,
		masterPassword: input.masterPassword,
	});
}

/**
 * A failed Runtime request. The `code` is the semantic outcome the UI must branch on;
 * the `message` is Rust diagnostic text and is not a user-facing string.
 */
export class RuntimeRequestError extends Error {
	readonly code: RuntimeErrorCode;

	constructor(error: RuntimeError) {
		super(error.message);
		this.name = "RuntimeRequestError";
		this.code = error.code;
	}
}

export function parseRuntimeSignedIn(responseJson: string): {
	accountId: string;
	userId: string;
} {
	const outcome = JSON.parse(responseJson) as RuntimeOutcome;
	if (outcome.type === "failed") {
		throw new RuntimeRequestError(outcome.value);
	}
	if (outcome.value.type !== "signedIn") {
		throw new Error("Runtime Sign-in did not return a signed-in Account");
	}
	return {
		accountId: outcome.value.accountId,
		userId: outcome.value.userId,
	};
}

/**
 * Drive a Runtime Sign-in or Quick Unlock, remember the Account ID, and return
 * it so Items observation uses the same Account the ceremony installed.
 */
export async function requestRuntimeSignIn(
	host: Pick<WorkerRuntime, "request">,
	requestId: string,
	requestJson: string,
): Promise<{ accountId: string; userId: string }> {
	const responseJson = await host.request(requestId, requestJson);
	const signedIn = parseRuntimeSignedIn(responseJson);
	setRuntimeAccountId(signedIn.accountId);
	return signedIn;
}

export async function signInWithRuntime(
	host: Pick<WorkerRuntime, "request">,
	input: {
		serverUrl: string;
		email: string;
		masterPassword: string;
		secretKey: string;
		insecureTransportConfirmed: boolean;
	},
): Promise<{ accountId: string; userId: string }> {
	return requestRuntimeSignIn(
		host,
		crypto.randomUUID(),
		runtimeSignInRequestJson(input),
	);
}

export async function quickUnlockWithRuntime(
	host: Pick<WorkerRuntime, "request">,
	input: {
		accountId: string;
		masterPassword: string;
	},
): Promise<{ accountId: string; userId: string }> {
	return requestRuntimeSignIn(
		host,
		crypto.randomUUID(),
		runtimeQuickUnlockRequestJson(input),
	);
}
