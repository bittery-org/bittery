import type {
	DeleteServerAccountInput,
	RuntimeServerAccountDeletion,
} from "@bittery/client-runtime/client";
import { transportErrorCode } from "@bittery/client-runtime/client";
import type {
	AccountRemovalIncomplete,
	AccountRemovalResult,
} from "./account-removal";

export type AccountDeletionPhase =
	| "prepared"
	| "dispatchedUnknown"
	| "serverDeleted";

export interface AccountDeletionTarget {
	readonly runtimeAccountId: string;
	readonly transitionalAccountId: string;
}

export interface AccountDeletionMarker extends AccountDeletionTarget {
	readonly version: 1;
	readonly confirmEmail: string;
	readonly requestId: string;
	readonly phase: AccountDeletionPhase;
}

const MARKER_KEYS = [
	"version",
	"runtimeAccountId",
	"transitionalAccountId",
	"confirmEmail",
	"requestId",
	"phase",
] as const;
const REQUEST_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function decodeAccountDeletionMarker(
	value: unknown,
): AccountDeletionMarker {
	if (typeof value !== "object" || value === null)
		throw new Error("Account deletion marker is malformed.");
	const marker = value as Record<string, unknown>;
	if (
		Object.keys(marker).length !== MARKER_KEYS.length ||
		!MARKER_KEYS.every((key) => Object.hasOwn(marker, key)) ||
		marker.version !== 1 ||
		typeof marker.runtimeAccountId !== "string" ||
		marker.runtimeAccountId.length === 0 ||
		typeof marker.transitionalAccountId !== "string" ||
		marker.transitionalAccountId.length === 0 ||
		typeof marker.confirmEmail !== "string" ||
		marker.confirmEmail.length === 0 ||
		new TextEncoder().encode(marker.confirmEmail).length > 254 ||
		typeof marker.requestId !== "string" ||
		!REQUEST_ID.test(marker.requestId) ||
		(marker.phase !== "prepared" &&
			marker.phase !== "dispatchedUnknown" &&
			marker.phase !== "serverDeleted")
	)
		throw new Error("Account deletion marker is malformed.");
	return marker as unknown as AccountDeletionMarker;
}

export interface DeleteAccountEverywhereDeps {
	resolveTarget(): Promise<AccountDeletionTarget | null>;
	readMarker(): AccountDeletionMarker | null;
	writeMarker(marker: AccountDeletionMarker | null): void;
	createRequestId(): string;
	normalizeAccountEmail(input: string): Promise<string>;
	deleteServerAccount(
		input: DeleteServerAccountInput,
	): Promise<RuntimeServerAccountDeletion>;
	removeLocalAccount(
		target: AccountDeletionTarget,
	): Promise<AccountRemovalResult>;
}

export type DeleteAccountEverywhereResult =
	| { readonly status: "deleted" }
	| {
			readonly status: "incomplete";
			readonly reason: string;
			readonly target?: AccountDeletionTarget;
			readonly serverAccountDeleted?: boolean;
			readonly local?: AccountRemovalIncomplete;
	  };

/** Gates Sign-out/RemoveAccount without destroying exact Server retry authority. */
export function gateLocalTeardown(
	target: AccountDeletionTarget,
	deps: Pick<DeleteAccountEverywhereDeps, "readMarker" | "writeMarker">,
): "allowed" | "recoveryRequired" {
	let marker: AccountDeletionMarker | null;
	try {
		marker = deps.readMarker();
	} catch {
		return "recoveryRequired";
	}
	if (marker === null || !matches(marker, target)) return "allowed";
	if (marker.phase === "dispatchedUnknown") return "recoveryRequired";
	if (marker.phase === "prepared" && !write(null, deps)) {
		return "recoveryRequired";
	}
	return "allowed";
}

/** Prevents Session refresh/reinstallation from racing durable deletion recovery. */
export function gateRuntimeAuthentication(
	deps: Pick<DeleteAccountEverywhereDeps, "readMarker" | "writeMarker">,
): "allowed" | "recoveryRequired" {
	let marker: AccountDeletionMarker | null;
	try {
		marker = deps.readMarker();
	} catch {
		return "recoveryRequired";
	}
	if (marker === null) return "allowed";
	if (marker.phase !== "prepared") return "recoveryRequired";
	return write(null, deps) ? "allowed" : "recoveryRequired";
}

export async function deleteAccountEverywhere(
	confirmEmail: string,
	deps: DeleteAccountEverywhereDeps,
): Promise<DeleteAccountEverywhereResult> {
	const target = await deps.resolveTarget();
	if (target === null)
		return { status: "incomplete", reason: "accountMissing" };

	let marker: AccountDeletionMarker | null;
	try {
		marker = deps.readMarker();
	} catch {
		return { status: "incomplete", reason: "markerUnavailable" };
	}
	if (marker !== null && !matches(marker, target)) {
		return { status: "incomplete", reason: "accountMismatch" };
	}
	if (marker === null) {
		let normalized: string;
		try {
			normalized = await deps.normalizeAccountEmail(confirmEmail);
		} catch {
			return { status: "incomplete", reason: "confirmationEmailInvalid" };
		}
		marker = {
			version: 1,
			...target,
			confirmEmail: normalized,
			requestId: deps.createRequestId(),
			phase: "prepared",
		};
		if (!write(marker, deps)) {
			return { status: "incomplete", reason: "markerUnavailable" };
		}
	}

	if (marker.phase === "prepared") {
		marker = { ...marker, phase: "dispatchedUnknown" };
		if (!write(marker, deps)) {
			return { status: "incomplete", reason: "markerUnavailable" };
		}
	}

	if (marker.phase === "dispatchedUnknown") {
		let answer: RuntimeServerAccountDeletion;
		try {
			answer = await deps.deleteServerAccount(command(marker));
		} catch (error) {
			const reason = transportErrorCode(error) ?? "unconfirmed";
			if (DEFINITIVE_REFUSALS.has(reason)) write(null, deps);
			return { status: "incomplete", reason };
		}
		if (answer.outcome !== "deleted") {
			write(null, deps);
			return { status: "incomplete", reason: answer.outcome };
		}
		marker = { ...marker, phase: "serverDeleted" };
		if (!write(marker, deps)) {
			return { status: "incomplete", reason: "markerUnavailable" };
		}
	}

	const local = await deps.removeLocalAccount(target);
	if (local.status !== "removed") {
		return {
			status: "incomplete",
			reason: "localTeardown",
			target,
			serverAccountDeleted: true,
			local: local.status === "incomplete" ? local : undefined,
		};
	}
	if (!write(null, deps))
		return { status: "incomplete", reason: "markerUnavailable" };
	return { status: "deleted" };
}

const DEFINITIVE_REFUSALS = new Set([
	"CANCELLED",
	"RUNTIME_CLOSED",
	"ACCOUNT_MISSING",
	"AUTHENTICATION_REQUIRED",
]);

function matches(
	marker: AccountDeletionMarker,
	target: AccountDeletionTarget,
): boolean {
	return (
		marker.runtimeAccountId === target.runtimeAccountId &&
		marker.transitionalAccountId === target.transitionalAccountId
	);
}

function command(marker: AccountDeletionMarker): DeleteServerAccountInput {
	return {
		accountId: marker.runtimeAccountId,
		confirmEmail: marker.confirmEmail,
		requestId: marker.requestId,
	};
}

function write(
	marker: AccountDeletionMarker | null,
	deps: Pick<DeleteAccountEverywhereDeps, "writeMarker">,
): boolean {
	try {
		deps.writeMarker(marker);
		return true;
	} catch {
		return false;
	}
}
