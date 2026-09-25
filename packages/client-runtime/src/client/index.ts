/**
 * The platform-neutral host binding: typed calls over the generated protocol, and stores
 * over the generated projections. Everything a host needs above the wire lives here, so a
 * Worker, a Tauri bridge, and an MV3 port differ only in the {@link RuntimeTransport} they
 * supply. Nothing in this entrypoint imports React.
 */

import type {
	CreateShareDraft,
	ItemsProjection,
	ObservationRequest,
	OperationsProjection,
	PendingShareResultsProjection,
	RuntimeOutcome,
	RuntimeRequest,
	RuntimeResponse,
	RuntimeStatusProjection,
	StorageRecoveryDiagnostics,
	VaultExportProjection,
	WritableVaultCatalogProjection,
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
import {
	observeVaultExport,
	type RuntimeVaultExportHandle,
	type RuntimeVaultExportOptions,
} from "./vault-export";

export type {
	RuntimeVaultExportHandle,
	RuntimeVaultExportOptions,
} from "./vault-export";

import { RuntimeRequestError, type RuntimeTransport } from "./transport";

export type {
	Address,
	AuthenticatorItemData,
	CreateVaultType,
	CreditCardItemData,
	DuplicateSourceGuard,
	EditableItemDraft,
	EditableLoginItemData,
	IdentityItemData,
	ImportItemDraft,
	ItemDraft,
	ItemDuplicateGuard,
	ItemEditGuard,
	ItemProjection,
	LoginItemData,
	OperationProjection,
	OperationsProjection,
	Passkey,
	PasskeyStatus,
	PasskeyStatusReason,
	PasswordHistoryEntry,
	PhoneNumber,
	PublicItemDraft,
	PublicLoginItemData,
	PublicPasskey,
	RecoveryBound,
	SecureNoteItemData,
	ShareAccessLog,
	ShareLinkSummary,
	StorageRecoveryAccount,
	StorageRecoveryDiagnostics,
	TotpAlgorithm,
	TotpDigits,
	VaultExportItem,
	VaultExportProjection,
	VaultImageSourceInput,
	WritableVaultCatalogProjection,
	WritableVaultProjection,
} from "../../generated/runtime-protocol/contract";

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
export type DeleteServerAccountInput = Omit<
	Extract<RuntimeRequest, { type: "deleteServerAccount" }>,
	"type"
>;
export type RuntimeServerAccountDeletion = Omit<
	Extract<RuntimeResponse, { type: "serverAccountDeletion" }>,
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
export type CreateItemInput = Omit<
	Extract<RuntimeRequest, { type: "createItem" }>,
	"type"
>;
export type UpdateItemInput = Omit<
	Extract<RuntimeRequest, { type: "updateItem" }>,
	"type"
>;
export type RemovePasskeyInput = Omit<
	Extract<RuntimeRequest, { type: "removePasskey" }>,
	"type"
>;
export type DuplicateItemInput = Omit<
	Extract<RuntimeRequest, { type: "duplicateItem" }>,
	"type"
>;
export type CreateVaultInput = Omit<
	Extract<RuntimeRequest, { type: "createVault" }>,
	"type"
>;
export type RuntimeVaultCreationAccepted = Omit<
	Extract<RuntimeResponse, { type: "vaultCreationAccepted" }>,
	"type"
>;
export type SetItemFavoriteInput = Omit<
	Extract<RuntimeRequest, { type: "setItemFavorite" }>,
	"type"
>;
export type TrashItemInput = Omit<
	Extract<RuntimeRequest, { type: "trashItem" }>,
	"type"
>;
export type RestoreItemInput = Omit<
	Extract<RuntimeRequest, { type: "restoreItem" }>,
	"type"
>;
export type MoveItemInput = Omit<
	Extract<RuntimeRequest, { type: "moveItem" }>,
	"type"
>;
export type PrepareCrossAccountMoveResumeInput = Omit<
	Extract<RuntimeRequest, { type: "prepareCrossAccountMoveResume" }>,
	"type"
>;
export type CrossAccountMoveResumeGuard = Extract<
	RuntimeResponse,
	{ type: "crossAccountMoveResumePrepared" }
>["guard"];
export type PermanentlyDeleteItemInput = Omit<
	Extract<RuntimeRequest, { type: "permanentlyDeleteItem" }>,
	"type"
>;
/**
 * One ordered, all-or-nothing Import batch of at most 200 plaintext drafts. The host supplies
 * category data and Favorite only; Rust mints every Item ID and owns the ciphertext.
 */
export type ImportItemsInput = Omit<
	Extract<RuntimeRequest, { type: "importItems" }>,
	"type"
>;
/**
 * The durable acceptance of one batch, including the Item IDs Rust minted in accepted order. It
 * is not the applied outcome: the batch is durable, and its authority arrives by reconciliation.
 */
export type RuntimeImportBatchAccepted = Omit<
	Extract<RuntimeResponse, { type: "importBatchAccepted" }>,
	"type"
>;
export type ListItemShareLinksInput = Omit<
	Extract<RuntimeRequest, { type: "listItemShareLinks" }>,
	"type"
>;
export type RuntimeTeamPage = Extract<
	RuntimeResponse,
	{ type: "teamPage" }
>["page"];
export type RuntimeAvailableVaultMembers = Extract<
	RuntimeResponse,
	{ type: "availableVaultMembers" }
>["members"];
export type RuntimeVaultMembers = Extract<
	RuntimeResponse,
	{ type: "vaultMembers" }
>["members"];
export type RuntimeVaultMemberAdd = Extract<
	RuntimeResponse,
	{ type: "vaultMemberAdded" | "vaultMemberAddUncertain" }
>;
export type RuntimeMyTeamInvitations = Extract<
	RuntimeResponse,
	{ type: "myTeamInvitations" }
>["invitations"];
export type RuntimeMyTeamInvitationAccept = Extract<
	RuntimeResponse,
	{
		type:
			| "myTeamInvitationAccepted"
			| "myTeamInvitationAcceptRefreshRequired"
			| "myTeamInvitationUncertain";
	}
>;
export type RuntimeMyTeamInvitationDecline = Extract<
	RuntimeResponse,
	{ type: "myTeamInvitationDeclined" | "myTeamInvitationUncertain" }
>;
export type RuntimeInvitationComposer = Extract<
	RuntimeResponse,
	{ type: "invitationComposer" }
>["composer"];
export type RuntimeInvitationCreation = Extract<
	RuntimeResponse,
	{ type: "teamInvitationCreated" | "teamInvitationUncertain" }
>;
export type RuntimeInvitationProvision = Extract<
	RuntimeResponse,
	{
		type:
			| "teamInvitationProvisioned"
			| "teamInvitationProvisioningNotRequired"
			| "teamInvitationUncertain";
	}
>;
export type RuntimeInvitationCancel = Extract<
	RuntimeResponse,
	{ type: "teamInvitationCancelled" | "teamInvitationAdminUncertain" }
>;
export type RuntimeInvitationResend = Extract<
	RuntimeResponse,
	{ type: "teamInvitationResent" | "teamInvitationAdminUncertain" }
>;
export type RuntimeRotationPreparation = Extract<
	RuntimeResponse,
	{
		type:
			| "rotationPrepared"
			| "rotationStartPending"
			| "rotationStartRejected"
			| "rotationPreparationRequiresCrypto";
	}
>;
export type RuntimeRotationInspection = Extract<
	RuntimeResponse,
	{
		type:
			| "rotationPrepared"
			| "rotationStartPending"
			| "rotationStartRejected"
			| "rotationPreparationRequiresCrypto"
			| "rotationAttemptConsumed"
			| "rotationFinalizePending"
			| "rotationRefreshRequired"
			| "rotationCompleted"
			| "rotationRejected";
	}
>;
export type RuntimeRotationCompletion = Extract<
	RuntimeRotationInspection,
	{
		type:
			| "rotationFinalizePending"
			| "rotationRefreshRequired"
			| "rotationCompleted"
			| "rotationRejected";
	}
>;
export type RuntimeTeamLeaveAttempts = Extract<
	RuntimeResponse,
	{ type: "teamLeaveAttempts" }
>;
export type RuntimeItemShareLinks = Omit<
	Extract<RuntimeResponse, { type: "itemShareLinks" }>,
	"type"
>;
export type ListShareAccessLogsInput = Omit<
	Extract<RuntimeRequest, { type: "listShareAccessLogs" }>,
	"type"
>;
export type RuntimeShareAccessLogs = Omit<
	Extract<RuntimeResponse, { type: "shareAccessLogs" }>,
	"type"
>;
export type RevokeShareLinkInput = Omit<
	Extract<RuntimeRequest, { type: "revokeShareLink" }>,
	"type"
>;
export type RuntimeShareLinkRevoked = Omit<
	Extract<RuntimeResponse, { type: "shareLinkRevoked" }>,
	"type"
>;
export type RenameAttachmentInput = Omit<
	Extract<RuntimeRequest, { type: "renameAttachment" }>,
	"type"
>;
export type DeleteAttachmentInput = Omit<
	Extract<RuntimeRequest, { type: "deleteAttachment" }>,
	"type"
>;
export type DownloadAttachmentInput = Omit<
	Extract<RuntimeRequest, { type: "downloadAttachment" }>,
	"type"
>;
export type UploadAttachmentInput = Omit<
	Extract<RuntimeRequest, { type: "uploadAttachment" }>,
	"type"
>;
export type RuntimeAttachmentRenamed = Omit<
	Extract<RuntimeResponse, { type: "attachmentRenamed" }>,
	"type"
>;
export type RuntimeAttachmentDeleted = Omit<
	Extract<RuntimeResponse, { type: "attachmentDeleted" }>,
	"type"
>;
export type RuntimeAttachmentDownloaded = Omit<
	Extract<RuntimeResponse, { type: "attachmentDownloaded" }>,
	"type"
>;
export type RuntimeAttachmentUploaded = Omit<
	Extract<RuntimeResponse, { type: "attachmentUploaded" }>,
	"type"
>;
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

type RuntimeTeardownResponse = Extract<RuntimeResponse, { type: "teardown" }>;

/**
 * The whole scoped teardown outcome, phases included. An `incomplete` teardown is a normal
 * answer, not an error: it names the phases that still hold data so a host can show them and
 * retry the identical scope. Collapsing it to a boolean would hide surviving material.
 *
 * The wire omits an empty phase list; this one is always present, so a caller renders the same
 * expression either way.
 */
export type RuntimeTeardown = Omit<
	RuntimeTeardownResponse,
	"type" | "failures"
> & { readonly failures: NonNullable<RuntimeTeardownResponse["failures"]> };

export interface RuntimeCallOptions {
	signal?: AbortSignal;
}

export interface RuntimeClient {
	listAvailableVaultMembers(
		input: Omit<
			Extract<RuntimeRequest, { type: "listAvailableVaultMembers" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAvailableVaultMembers>;
	listVaultMembers(
		input: Omit<Extract<RuntimeRequest, { type: "listVaultMembers" }>, "type">,
		options?: RuntimeCallOptions,
	): Promise<RuntimeVaultMembers>;
	addVaultMember(
		input: Omit<Extract<RuntimeRequest, { type: "addVaultMember" }>, "type">,
		options?: RuntimeCallOptions,
	): Promise<RuntimeVaultMemberAdd>;
	prepareRotation(
		input: Omit<Extract<RuntimeRequest, { type: "prepareRotation" }>, "type">,
		options?: RuntimeCallOptions,
	): Promise<RuntimeRotationPreparation>;
	completeRotation(
		input: Omit<Extract<RuntimeRequest, { type: "completeRotation" }>, "type">,
		options?: RuntimeCallOptions,
	): Promise<RuntimeRotationCompletion>;
	inspectRotation(
		input: Omit<Extract<RuntimeRequest, { type: "inspectRotation" }>, "type">,
		options?: RuntimeCallOptions,
	): Promise<RuntimeRotationInspection>;
	listTeamLeaveAttempts(
		input: Omit<
			Extract<RuntimeRequest, { type: "listTeamLeaveAttempts" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<RuntimeTeamLeaveAttempts["attempts"]>;
	acknowledgeTeamLeaveAttempt(
		input: Omit<
			Extract<RuntimeRequest, { type: "acknowledgeTeamLeaveAttempt" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<void>;
	listMyTeamInvitations(
		input: Omit<
			Extract<RuntimeRequest, { type: "listMyTeamInvitations" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<RuntimeMyTeamInvitations>;
	acceptMyTeamInvitation(
		input: Omit<
			Extract<RuntimeRequest, { type: "acceptMyTeamInvitation" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<RuntimeMyTeamInvitationAccept>;
	declineMyTeamInvitation(
		input: Omit<
			Extract<RuntimeRequest, { type: "declineMyTeamInvitation" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<RuntimeMyTeamInvitationDecline>;
	readInvitationComposer(
		input: Omit<
			Extract<RuntimeRequest, { type: "readInvitationComposer" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<RuntimeInvitationComposer>;
	createTeamInvitation(
		input: Omit<
			Extract<RuntimeRequest, { type: "createTeamInvitation" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<RuntimeInvitationCreation>;
	provisionTeamInvitation(
		input: Omit<
			Extract<RuntimeRequest, { type: "provisionTeamInvitation" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<RuntimeInvitationProvision>;
	cancelTeamInvitation(
		input: Omit<
			Extract<RuntimeRequest, { type: "cancelTeamInvitation" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<RuntimeInvitationCancel>;
	resendTeamInvitation(
		input: Omit<
			Extract<RuntimeRequest, { type: "resendTeamInvitation" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<RuntimeInvitationResend>;
	releaseInvitationContinuation(
		input: Omit<
			Extract<RuntimeRequest, { type: "releaseInvitationContinuation" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<void>;
	readTeamPage(
		input: Omit<Extract<RuntimeRequest, { type: "readTeamPage" }>, "type">,
		options?: RuntimeCallOptions,
	): Promise<RuntimeTeamPage>;
	recipientKeyScope(
		input: Omit<Extract<RuntimeRequest, { type: "recipientKeyScope" }>, "type">,
		options?: RuntimeCallOptions,
	): Promise<Extract<RuntimeResponse, { type: "recipientKeyScope" }>>;
	ownKeyFingerprint(
		input: Omit<Extract<RuntimeRequest, { type: "ownKeyFingerprint" }>, "type">,
		options?: RuntimeCallOptions,
	): Promise<Extract<RuntimeResponse, { type: "ownKeyFingerprint" }>>;
	verifyRecipientKey(
		input: Omit<
			Extract<RuntimeRequest, { type: "verifyRecipientKey" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<Extract<RuntimeResponse, { type: "recipientKeyVerified" }>>;
	verifiedRecipientKey(
		input: Omit<
			Extract<RuntimeRequest, { type: "verifiedRecipientKey" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<Extract<RuntimeResponse, { type: "verifiedRecipientKey" }>>;
	rebootstrapAccountRecovery(
		input: Omit<
			Extract<RuntimeRequest, { type: "rebootstrapAccountRecovery" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<
		Omit<Extract<RuntimeResponse, { type: "recoveryRepaired" }>, "type">
	>;
	inspectRecovery(
		input?: Omit<Extract<RuntimeRequest, { type: "inspectRecovery" }>, "type">,
		options?: RuntimeCallOptions,
	): Promise<StorageRecoveryDiagnostics>;
	exportAccountRecovery(
		input: Omit<
			Extract<RuntimeRequest, { type: "exportAccountRecovery" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<
		Omit<Extract<RuntimeResponse, { type: "recoveryExported" }>, "type">
	>;
	repairAccountRecovery(
		input: Omit<
			Extract<RuntimeRequest, { type: "repairAccountRecovery" }>,
			"type"
		>,
		options?: RuntimeCallOptions,
	): Promise<
		Omit<Extract<RuntimeResponse, { type: "recoveryRepaired" }>, "type">
	>;
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
	/**
	 * Destroys one named Account on this Device. Irreversible, and never inferred from the
	 * active-Account pointer. An identical retry converges after an `incomplete` outcome.
	 */
	removeAccount(
		accountId: string,
		options?: RuntimeCallOptions,
	): Promise<RuntimeTeardown>;
	/** Uses caller-owned durable retry material to delete the authenticated Server Account. */
	deleteServerAccount(
		input: DeleteServerAccountInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeServerAccountDeletion>;
	/** Destroys every Account and all Runtime state on this Device. Irreversible. */
	wipe(options?: RuntimeCallOptions): Promise<RuntimeTeardown>;
	createVault(
		input: CreateVaultInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeVaultCreationAccepted>;
	createItem(
		input: CreateItemInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	updateItem(
		input: UpdateItemInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	removePasskey(
		input: RemovePasskeyInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	duplicateItem(
		input: DuplicateItemInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	setItemFavorite(
		input: SetItemFavoriteInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	trashItem(
		input: TrashItemInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	restoreItem(
		input: RestoreItemInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	moveItem(
		input: MoveItemInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	prepareCrossAccountMoveResume(
		input: PrepareCrossAccountMoveResumeInput,
		options?: RuntimeCallOptions,
	): Promise<CrossAccountMoveResumeGuard>;
	resumeCrossAccountMove(
		guard: CrossAccountMoveResumeGuard,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	permanentlyDeleteItem(
		input: PermanentlyDeleteItemInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	/**
	 * Durably accepts one ordered Import batch. Resolving means the batch survives a restart, not
	 * that the Server applied it.
	 */
	importItems(
		input: ImportItemsInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeImportBatchAccepted>;
	listItemShareLinks(
		input: ListItemShareLinksInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeItemShareLinks>;
	listShareAccessLogs(
		input: ListShareAccessLogsInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeShareAccessLogs>;
	revokeShareLink(
		input: RevokeShareLinkInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeShareLinkRevoked>;
	renameAttachment(
		input: RenameAttachmentInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAttachmentRenamed>;
	deleteAttachment(
		input: DeleteAttachmentInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAttachmentDeleted>;
	downloadAttachment(
		input: DownloadAttachmentInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAttachmentDownloaded>;
	uploadAttachment(
		input: UploadAttachmentInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAttachmentUploaded>;
	createShare(
		input: CreateShareInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeAccepted>;
	acknowledgeShareResult(
		input: AcknowledgeShareResultInput,
		options?: RuntimeCallOptions,
	): Promise<RuntimeShareResultAcknowledged>;
	observeVaultExport(
		input: { accountId: string; vaultIds: string[] },
		listener: (snapshot: VaultExportProjection) => void,
		options: RuntimeVaultExportOptions,
	): Promise<RuntimeVaultExportHandle>;
	/** The Items observation for one Account. The same Account returns the same store. */
	items(accountId: string): RuntimeStore<ItemsProjection>;
	operations(accountId: string): RuntimeStore<OperationsProjection>;
	/** Durable, Account-scoped Share results waiting for host delivery acknowledgement. */
	pendingShareResults(
		accountId: string,
	): RuntimeStore<PendingShareResultsProjection>;
	/** Authority-only writable Vault metadata across all unlocked Accounts on this Device. */
	writableVaults(): RuntimeStore<WritableVaultCatalogProjection>;
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
		expected: Variant | readonly Variant[],
		callOptions: RuntimeCallOptions | undefined,
	): Promise<Extract<RuntimeResponse, { type: Variant }>> {
		requests += 1;
		const responseJson = await transport.request(
			`${prefix}-request-${requests}`,
			JSON.stringify(request),
			callOptions,
		);
		const response = decodeOutcome(responseJson);
		if (
			typeof expected === "string"
				? response.type !== expected
				: !expected.includes(response.type as Variant)
		) {
			throw new RuntimeRequestError(
				"INVARIANT_VIOLATION",
				`The Runtime answered ${request.type} with ${response.type}`,
			);
		}
		return response as Extract<RuntimeResponse, { type: Variant }>;
	}

	return {
		listAvailableVaultMembers: async (input, options) =>
			(
				await call(
					{ type: "listAvailableVaultMembers", ...input },
					"availableVaultMembers",
					options,
				)
			).members,
		listVaultMembers: async (input, options) =>
			(
				await call(
					{ type: "listVaultMembers", ...input },
					"vaultMembers",
					options,
				)
			).members,
		addVaultMember: (input, options) =>
			call(
				{ type: "addVaultMember", ...input },
				["vaultMemberAdded", "vaultMemberAddUncertain"] as const,
				options,
			),
		prepareRotation: (input, options) =>
			call(
				{ type: "prepareRotation", ...input },
				[
					"rotationPrepared",
					"rotationStartPending",
					"rotationStartRejected",
					"rotationPreparationRequiresCrypto",
				] as const,
				options,
			),
		completeRotation: (input, options) =>
			call(
				{ type: "completeRotation", ...input },
				[
					"rotationFinalizePending",
					"rotationRefreshRequired",
					"rotationCompleted",
					"rotationRejected",
				] as const,
				options,
			),
		inspectRotation: (input, options) =>
			call(
				{ type: "inspectRotation", ...input },
				[
					"rotationPrepared",
					"rotationStartPending",
					"rotationStartRejected",
					"rotationPreparationRequiresCrypto",
					"rotationAttemptConsumed",
					"rotationFinalizePending",
					"rotationRefreshRequired",
					"rotationCompleted",
					"rotationRejected",
				] as const,
				options,
			),
		listTeamLeaveAttempts: (input, options) =>
			call(
				{ type: "listTeamLeaveAttempts", ...input },
				"teamLeaveAttempts",
				options,
			).then((answer) => answer.attempts),
		acknowledgeTeamLeaveAttempt: async (input, options) => {
			await call(
				{ type: "acknowledgeTeamLeaveAttempt", ...input },
				"teamLeaveAttemptAcknowledged",
				options,
			);
		},
		listMyTeamInvitations: async (input, options) =>
			(
				await call(
					{ type: "listMyTeamInvitations", ...input },
					"myTeamInvitations",
					options,
				)
			).invitations,
		acceptMyTeamInvitation: (input, options) =>
			call(
				{ type: "acceptMyTeamInvitation", ...input },
				[
					"myTeamInvitationAccepted",
					"myTeamInvitationAcceptRefreshRequired",
					"myTeamInvitationUncertain",
				] as const,
				options,
			),
		declineMyTeamInvitation: (input, options) =>
			call(
				{ type: "declineMyTeamInvitation", ...input },
				["myTeamInvitationDeclined", "myTeamInvitationUncertain"] as const,
				options,
			),
		readInvitationComposer: async (input, options) =>
			(
				await call(
					{ type: "readInvitationComposer", ...input },
					"invitationComposer",
					options,
				)
			).composer,
		createTeamInvitation: (input, options) =>
			call(
				{ type: "createTeamInvitation", ...input },
				["teamInvitationCreated", "teamInvitationUncertain"] as const,
				options,
			),
		provisionTeamInvitation: (input, options) =>
			call(
				{ type: "provisionTeamInvitation", ...input },
				[
					"teamInvitationProvisioned",
					"teamInvitationProvisioningNotRequired",
					"teamInvitationUncertain",
				] as const,
				options,
			),
		cancelTeamInvitation: (input, options) =>
			call(
				{ type: "cancelTeamInvitation", ...input },
				["teamInvitationCancelled", "teamInvitationAdminUncertain"] as const,
				options,
			),
		resendTeamInvitation: (input, options) =>
			call(
				{ type: "resendTeamInvitation", ...input },
				["teamInvitationResent", "teamInvitationAdminUncertain"] as const,
				options,
			),
		releaseInvitationContinuation: async (input, options) => {
			await call(
				{ type: "releaseInvitationContinuation", ...input },
				"invitationContinuationReleased",
				options,
			);
		},
		readTeamPage: async (input, options) =>
			(await call({ type: "readTeamPage", ...input }, "teamPage", options))
				.page,
		ownKeyFingerprint: (input, options) =>
			call(
				{ type: "ownKeyFingerprint", ...input },
				"ownKeyFingerprint",
				options,
			),
		recipientKeyScope: (input, options) =>
			call(
				{ type: "recipientKeyScope", ...input },
				"recipientKeyScope",
				options,
			),
		verifyRecipientKey: (input, options) =>
			call(
				{ type: "verifyRecipientKey", ...input },
				"recipientKeyVerified",
				options,
			),
		verifiedRecipientKey: (input, options) =>
			call(
				{ type: "verifiedRecipientKey", ...input },
				"verifiedRecipientKey",
				options,
			),
		observeVaultExport(input, listener, captureOptions) {
			requests += 1;
			return observeVaultExport(
				transport,
				`${prefix}-export-${requests}`,
				input,
				listener,
				captureOptions,
			);
		},
		async rebootstrapAccountRecovery(input, callOptions) {
			const { type: _, ...result } = await call(
				{ type: "rebootstrapAccountRecovery", ...input },
				"recoveryRepaired",
				callOptions,
			);
			return result;
		},
		async inspectRecovery(input, callOptions) {
			const { diagnostics } = await call(
				{ type: "inspectRecovery", ...input },
				"recoveryDiagnosed",
				callOptions,
			);
			return diagnostics;
		},
		async exportAccountRecovery(input, callOptions) {
			const { type: _, ...result } = await call(
				{ type: "exportAccountRecovery", ...input },
				"recoveryExported",
				callOptions,
			);
			return result;
		},
		async repairAccountRecovery(input, callOptions) {
			const { type: _, ...result } = await call(
				{ type: "repairAccountRecovery", ...input },
				"recoveryRepaired",
				callOptions,
			);
			return result;
		},
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
		async removeAccount(accountId, callOptions) {
			return teardownOutcome(
				await call(
					{ type: "removeAccount", accountId },
					"teardown",
					callOptions,
				),
			);
		},
		async deleteServerAccount(input, callOptions) {
			const { accountId, requestId, outcome } = await call(
				{ type: "deleteServerAccount", ...input },
				"serverAccountDeletion",
				callOptions,
			);
			return { accountId, requestId, outcome };
		},
		async wipe(callOptions) {
			return teardownOutcome(
				await call({ type: "wipe" }, "teardown", callOptions),
			);
		},
		async createVault(input, callOptions) {
			const { operationId, vaultId, replicaRevision } = await call(
				{ type: "createVault", ...input },
				"vaultCreationAccepted",
				callOptions,
			);
			return { operationId, vaultId, replicaRevision };
		},
		async createItem(input, callOptions) {
			const { operationId, itemId, replicaRevision } = await call(
				{ type: "createItem", ...input },
				"accepted",
				callOptions,
			);
			return { operationId, itemId, replicaRevision };
		},
		async updateItem(input, callOptions) {
			return accepted(
				await call({ type: "updateItem", ...input }, "accepted", callOptions),
			);
		},
		async removePasskey(input, callOptions) {
			return accepted(
				await call(
					{ type: "removePasskey", ...input },
					"accepted",
					callOptions,
				),
			);
		},
		async duplicateItem(input, callOptions) {
			return accepted(
				await call(
					{ type: "duplicateItem", ...input },
					"accepted",
					callOptions,
				),
			);
		},
		async setItemFavorite(input, callOptions) {
			return accepted(
				await call(
					{ type: "setItemFavorite", ...input },
					"accepted",
					callOptions,
				),
			);
		},
		async trashItem(input, callOptions) {
			return accepted(
				await call({ type: "trashItem", ...input }, "accepted", callOptions),
			);
		},
		async restoreItem(input, callOptions) {
			return accepted(
				await call({ type: "restoreItem", ...input }, "accepted", callOptions),
			);
		},
		async moveItem(input, callOptions) {
			return accepted(
				await call({ type: "moveItem", ...input }, "accepted", callOptions),
			);
		},
		async prepareCrossAccountMoveResume(input, callOptions) {
			const { guard } = await call(
				{ type: "prepareCrossAccountMoveResume", ...input },
				"crossAccountMoveResumePrepared",
				callOptions,
			);
			return guard;
		},
		async resumeCrossAccountMove(guard, callOptions) {
			return accepted(
				await call(
					{ type: "resumeCrossAccountMove", guard },
					"accepted",
					callOptions,
				),
			);
		},
		async permanentlyDeleteItem(input, callOptions) {
			return accepted(
				await call(
					{ type: "permanentlyDeleteItem", ...input },
					"accepted",
					callOptions,
				),
			);
		},
		async importItems(input, callOptions) {
			const { operationId, vaultId, itemIds, replicaRevision } = await call(
				{ type: "importItems", ...input },
				"importBatchAccepted",
				callOptions,
			);
			return { operationId, vaultId, itemIds, replicaRevision };
		},
		async listItemShareLinks(input, callOptions) {
			const { type: _, ...result } = await call(
				{ type: "listItemShareLinks", ...input },
				"itemShareLinks",
				callOptions,
			);
			return result;
		},
		async listShareAccessLogs(input, callOptions) {
			const { type: _, ...result } = await call(
				{ type: "listShareAccessLogs", ...input },
				"shareAccessLogs",
				callOptions,
			);
			return result;
		},
		async revokeShareLink(input, callOptions) {
			const { type: _, ...result } = await call(
				{ type: "revokeShareLink", ...input },
				"shareLinkRevoked",
				callOptions,
			);
			return result;
		},
		async renameAttachment(input, callOptions) {
			const { accountId, attachmentId } = await call(
				{ type: "renameAttachment", ...input },
				"attachmentRenamed",
				callOptions,
			);
			return { accountId, attachmentId };
		},
		async deleteAttachment(input, callOptions) {
			const { accountId, attachmentId } = await call(
				{ type: "deleteAttachment", ...input },
				"attachmentDeleted",
				callOptions,
			);
			return { accountId, attachmentId };
		},
		async downloadAttachment(input, callOptions) {
			const { accountId, attachmentId } = await call(
				{ type: "downloadAttachment", ...input },
				"attachmentDownloaded",
				callOptions,
			);
			return { accountId, attachmentId };
		},
		async uploadAttachment(input, callOptions) {
			const { attachmentId, replicaRevision } = await call(
				{ type: "uploadAttachment", ...input },
				"attachmentUploaded",
				callOptions,
			);
			return { attachmentId, replicaRevision };
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
		operations(accountId) {
			return registry.store<OperationsProjection>({
				type: "operations",
				accountId,
			});
		},
		pendingShareResults(accountId) {
			return registry.store<PendingShareResultsProjection>({
				type: "pendingShareResults",
				accountId,
			} satisfies ObservationRequest);
		},
		writableVaults() {
			return registry.store<WritableVaultCatalogProjection>({
				type: "writableVaultCatalog",
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

function teardownOutcome(answer: RuntimeTeardownResponse): RuntimeTeardown {
	const { scope, status, failures } = answer;
	return { scope, status, failures: failures ?? [] };
}

function accepted(
	answer: Extract<RuntimeResponse, { type: "accepted" }>,
): RuntimeAccepted {
	const { operationId, itemId, replicaRevision } = answer;
	return { operationId, itemId, replicaRevision };
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
		throw new RuntimeRequestError(
			outcome.value.code,
			outcome.value.message,
			outcome.value.recoveryBound ?? undefined,
			outcome.value.teamPageProblem ?? undefined,
		);
	}
	return outcome.value;
}
