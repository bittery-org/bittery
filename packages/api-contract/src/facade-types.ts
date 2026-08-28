import type { components, operations } from "./generated/schema.ts";

type Schema<Name extends keyof components["schemas"]> =
	components["schemas"][Name];

export interface ApiResult<T> {
	data: T;
	etag: string | null;
	requestId: string | null;
}

export interface ApiWriteOptions {
	etag?: string;
	idempotencyKey?: string;
}

/**
 * The write options an Item Operation requires.
 *
 * `Idempotency-Key` is no longer an optimisation a caller may skip: it carries the stable
 * Operation ID, and the Server refuses an Item mutation without one.
 */
export interface CreateItemWriteOptions extends ApiWriteOptions {
	idempotencyKey: string;
}

/** An Item mutation additionally requires the strong version it is written against. */
export interface ItemOperationWriteOptions extends CreateItemWriteOptions {
	etag: string;
}

export interface ApiPageRequest {
	cursor?: string;
	limit?: number;
}

export interface SyncBootstrapRequest extends ApiPageRequest {
	phase: SyncBootstrapPage["phase"];
	syncCursor?: string;
	syncCursorCaptured?: boolean;
}

export interface ApiPage<T> {
	items: readonly T[];
	nextCursor?: string | null;
	hasMore: boolean;
}

/**
 * The closed sets. Each is a Rust enum in `apps/server/src/db/enums.rs` that reaches
 * OpenAPI as a string enum, so the client union is generated rather than typed twice —
 * see ADR 0012. Nothing downstream may restate these; alias them instead.
 */
export type BillingPlan = Schema<"BillingPlan">;
export type BillingStatus = Schema<"BillingStatus">;
export type InvitationStatus = Schema<"InvitationStatus">;
export type ItemCategory = Schema<"ItemCategory">;
export type ShareLinkAccessMode = Schema<"ShareLinkAccessMode">;
export type ShareLinkStatus = Schema<"ShareLinkStatus">;
export type SyncEntityType = Schema<"SyncEntityType">;
export type SyncEventType = Schema<"SyncEventType">;
export type TeamRole = Schema<"TeamRole">;
export type TeamType = Schema<"TeamType">;
export type VaultRole = Schema<"VaultRole">;
export type VaultType = Schema<"VaultType">;

/**
 * The server's stable, machine-readable error codes. `ApiProblem.code` stays `string`
 * on purpose: the transport also mints codes of its own (`HTTP_ERROR`) for responses
 * that never reached a Bittery handler, so a narrowed field there would be a lie.
 */
export type ErrorCode = Schema<"ErrorCode">;

export type EmailCheckInput = Schema<"EmailCheckRequest">;
export type EmailCheckResponse = Schema<"EmailCheckResponse">;
export type RegistrationStatus = Schema<"RegistrationStatusResponse">;
export type StartLoginInput = Schema<"StartLoginRequest">;
export type LoginAttempt = Schema<"LoginAttemptResponse">;
export type FinishLoginInput = Schema<"FinishLoginRequest">;
type WireFinishLoginResponse = Schema<"FinishLoginResponse">;
export type FinishLoginResponse = Omit<WireFinishLoginResponse, "vaultKeys"> & {
	vaultKeys: ApiPage<AuthVaultKey>;
};
export type RecoverySessionInput = Schema<"RecoverySessionRequest">;
export type RecoveryData = Schema<"RecoveryDataResponse">;
export type ResetPasswordInput = Schema<"ResetPasswordRequest">;
export type ResetPasswordResponse = Schema<"ResetPasswordResponse">;
export type RecoveryVerificationInput = Schema<"RecoveryVerificationRequest">;
export type RenameSessionInput = Schema<"RenameSessionRequest">;
export type VerifyRecoveryInput = Schema<"VerifyRecoveryRequest">;
export type VerifyRecoveryResponse = Schema<"VerifyRecoveryResponse">;
export type SignupVerificationInput = Schema<"SignupVerificationRequest">;
export type VerifySignupVerificationInput =
	Schema<"VerifySignupVerificationRequest">;
export type VerifySignupVerificationResponse =
	Schema<"VerifySignupVerificationResponse">;
export type SignupInput = Schema<"SignupRequest">;
type WireSignupResponse = Schema<"SignupResponse">;
export type SignupResponse = Omit<WireSignupResponse, "vaultKeys"> & {
	vaultKeys: readonly AuthVaultKey[];
};
export type AuthUser = Schema<"MeResponse">;
export type DeleteAccountInput = Schema<"DeleteAccountRequest">;
export type DeleteAccountResponse = Schema<"DeleteAccountResponse">;
export type EmailChangeInput = Schema<"EmailChangeRequest">;
export type PasswordChangeInput = Schema<"PasswordChangeRequest">;
export type RecoveryKeyInput = Schema<"RecoveryKeyRequest">;
export type SecretKeyRotationInput = Schema<"SecretKeyRotationRequest">;
export type Session = Omit<
	Schema<"SessionResponse">,
	"createdAt" | "lastActiveAt"
> & {
	createdAt: Date;
	lastActiveAt: Date;
};
export type RefreshSessionResponse = Schema<"RefreshSessionResponse">;
export type AuthVaultKey = Schema<"AuthVaultKeyResponse">;

export type Vault = Schema<"VaultListEntryResponse">;
export type VaultDetails = Schema<"VaultDetailsResponseDto">;
export type CreateVaultInput = Schema<"CreateVaultBody">;
export type CreateVaultResponse = Schema<"CreateVaultResponse">;
export type UpdateVaultInput = Schema<"UpdateVaultBody">;
export type UpdateVaultResponse = Schema<"UpdateVaultResponse">;
export type VaultStats = Omit<
	Schema<"VaultStatsResponseDto">,
	"itemCount" | "vaultCount"
> & {
	itemCount: bigint;
	vaultCount: bigint;
};
export type ImageUploadInput = Schema<"ImageUploadBody">;
export type PresignedUpload = Schema<"PresignedUploadResponse">;
export type ConvertVaultInput = Schema<"ConvertVaultBody">;
export type ConvertVaultResponse = Schema<"ConvertVaultTypeResponse">;
export type BulkImportInput = Schema<"BulkImportBody">;
export type BulkImportResponse = Schema<"BulkImportItemsResponse">;

/**
 * The fields every server Item payload carries, whichever endpoint returned it.
 *
 * Six generated schemas restate them — {@link VaultItem}, {@link VaultItemDetails},
 * {@link DeletedVaultItem}, {@link SyncBootstrapItem}, `VaultItemResponse` and this one —
 * because utoipa cannot flatten a shared component without rewriting all six as `allOf`,
 * which would break the published contract. `ItemResponseDto`, the `GET /items/{itemId}`
 * body, is the one that carries these fields and nothing else, so it is the canonical set
 * every client-side Item shape derives from. The others are this plus `attachments`,
 * `vault`, or both.
 */
export type ItemPayload = Schema<"ItemResponseDto">;

type WireVaultItem = Schema<"AllItemsResponse">["items"][number];
export type VaultItem = Omit<WireVaultItem, "attachments"> & {
	attachments: readonly Attachment[];
};
export type VaultItemDetails = Schema<"VaultItemDetailsResponse">;
export type DeletedVaultItem = Schema<"DeletedVaultItemWithVaultResponse">;
export type CreateItemInput = Schema<"CreateItemBody">;
/**
 * The one retained Operation outcome, discriminated by `kind`.
 *
 * `GET /operations/{operationId}` answers this union, because a caller recovering from a lost
 * response is exactly the caller that does not yet know what happened. Read `kind`, check it
 * against your own durable record, and only then read `result`.
 */
export type OperationOutcome = Schema<"OperationOutcome">;
/** The retained outcomes returned directly by Item mutation routes. */
export type ItemOperationOutcome = Extract<
	OperationOutcome,
	{
		kind:
			| "create_item"
			| "update_item"
			| "set_item_favorite"
			| "trash_item"
			| "restore_item"
			| "move_item"
			| "permanently_delete_item";
	}
>;
export type ItemOperationResult = Schema<"ItemOperationResult">;
export type OperationRejectionCode = Schema<"OperationRejectionCode">;
export type CreateItemOperationOutcome = Extract<
	OperationOutcome,
	{ kind: "create_item" }
>;
export type UpdateItemInput = Schema<"UpdateItemBody">;
export type FavoriteInput = Schema<"FavoriteBody">;
export type MoveItemInput = Schema<"MoveItemBody">;

export type Attachment = Schema<"VaultAttachmentResponse">;
export type CreateAttachmentInput = Schema<"CreateAttachmentBody">;
export type CreateAttachmentResponse = Schema<"CreateAttachmentResponse">;
export type UpdateAttachmentInput = Schema<"UpdateAttachmentBody">;
export type AttachmentUploadInput = Schema<"AttachmentUploadBody">;
export type AttachmentUpload = Schema<"AttachmentUploadResponse">;
export type AttachmentDownload = Schema<"AttachmentDownloadResponse">;

export type AvailableTeamMember = Schema<"VaultAvailableMemberResponse">;
export type VaultMember = Schema<"VaultMemberResponse">;
export type AddVaultMemberInput = Schema<"AddVaultMemberBody">;
export type UpdateVaultMemberRoleInput = Schema<"UpdateVaultMemberRoleBody">;
export type RotationPlanSet = Schema<"PlanSetResponse">;
export type RotationPlanSetFinalizeInput = Schema<"FinalizePlanSetRequest">;
export type RotationPlanSetFinalizeResponse = Schema<"FinalizePlanSetResponse">;
export type RotationPreparationPage = Schema<"PreparationPage">;
export type RotationStageInput = Schema<"StageRequest">;

export type CreateTeamInput = Schema<"CreateTeamRequest">;
export type UpdateTeamInput = Schema<"UpdateTeamRequest">;
export type TeamImageUploadInput = Schema<"ImageUploadRequest">;
export type TeamSummary = Schema<"TeamSummaryResponse">;
export type TeamDetails = Schema<"TeamDetailsResponse">;
export type TeamInvitation = Schema<"InvitationListResponse">;
export type PendingTeamInvitation = Schema<"PendingInvitationResponse">;
export type PublicTeamInvitation = Schema<"InvitationDetailsResponse">;
export type SendTeamInvitationInput = Schema<"SendInvitationRequest">;
export type SendTeamInvitationResponse = Schema<"SendInvitationResponse">;
export type ResendTeamInvitationResponse = Schema<"ResendInvitationResponse">;
export type AcceptTeamInvitationResponse = Schema<"AcceptInvitationResponse">;
export type TeamMember = Schema<"TeamMemberResponse">;
export type TeamMemberAccess = Schema<"MemberAccessResponse">;
export type TeamVault = Schema<"TeamVaultResponse">;

export type ShareLinkList = Schema<"ShareLinkListResponse">;
export type PublicShareInfo = Schema<"PublicShareInfoResponse">;
export type EmailShareAccessInput = Schema<"EmailAccessRequest">;
export type EmailShareVerificationInput = Schema<"EmailVerificationRequest">;
export type PublicShareAccess = Schema<"PublicShareAccessResponse">;
export type EmailShareVerification = Schema<"EmailVerificationResponse">;
export type ShareAccessLog = Schema<"ShareAccessLogResponse">;
type NullableBigInt = bigint | null | undefined;

export type BillingEntitlements = Omit<
	Schema<"BillingEntitlementsResponse">,
	"limits"
> & {
	limits: Omit<
		Schema<"EntitlementLimits">,
		| "attachmentMaxFileSizeBytes"
		| "attachmentStorageBytes"
		| "shareLinks"
		| "sharedVaults"
	> & {
		attachmentMaxFileSizeBytes?: NullableBigInt;
		attachmentStorageBytes?: NullableBigInt;
		shareLinks?: NullableBigInt;
		sharedVaults?: NullableBigInt;
	};
};
/** The billing *panel* — the subscription's state, not the {@link BillingStatus} value. */
export type BillingStatusSummary = Schema<"BillingStatusResponse">;
export type AttachmentUsage = Omit<
	Schema<"AttachmentUsageResponse">,
	"committedStorageBytes" | "quotaBytes"
> & {
	committedStorageBytes: bigint;
	quotaBytes?: NullableBigInt;
};
export type CheckoutSessionInput = Schema<"CheckoutSessionRequest">;
export type CheckoutSession = Schema<"CheckoutSessionResponse">;
export type PortalSession = Schema<"PortalSessionResponse">;
export type TeamSeatInvoicePreview = NonNullable<
	operations["previewAdditionalTeamSeat"]["responses"][200]["content"]["application/json"]
>;
export type TravelMode = Schema<"TravelModeResponse">;
export type HiddenVaultsInput = Schema<"HiddenVaultsRequest">;
export type DisableTravelModeInput = Schema<"DisableTravelModeRequest">;
export type AuditEvents = Schema<"AuditEventsResponse">;
export type AuditEvent = Schema<"TeamEvent">;
/**
 * Derived rather than restated: the filter vocabulary (`actionGroup`, `result`)
 * is server-owned, so a new group added in Rust arrives here instead of failing
 * as an unknown query value at runtime. ADR 0012.
 */
export type AuditEventsRequest = NonNullable<
	operations["listAuditEvents"]["parameters"]["query"]
>;

export type SyncBootstrapPage = Schema<"BootstrapItemsResponse">;
export type SyncBootstrapItem = Schema<"BootstrapItemResponse">;
export type SyncEvent = Omit<Schema<"SyncEventResponse">, "timestamp"> & {
	timestamp: bigint;
};
export type SyncChanges = Omit<Schema<"SyncChangesResponse">, "events"> & {
	events: readonly SyncEvent[];
};
