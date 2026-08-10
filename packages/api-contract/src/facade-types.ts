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

export interface ApiPageRequest {
	cursor?: string;
	limit?: number;
}

export interface ApiPage<T> {
	items: readonly T[];
	nextCursor?: string | null;
	hasMore: boolean;
}

export interface ApiReadOptions<T> {
	queryKey: readonly unknown[];
	queryFn: () => Promise<T>;
}

export type EmailCheckInput = Schema<"EmailCheckRequest">;
export type EmailCheckResponse = Schema<"EmailCheckResponse">;
export type RegistrationStatus = Schema<"RegistrationStatusResponse">;
export type StartLoginInput = Schema<"StartLoginRequest">;
export type LoginAttempt = Schema<"LoginAttemptResponse">;
export type FinishLoginInput = Schema<"FinishLoginRequest">;
export type FinishLoginResponse = Schema<"FinishLoginResponse">;
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
export type SignupResponse = Schema<"SignupResponse">;
export type AuthUser = Schema<"MeResponse">;
export type DeleteAccountInput = Schema<"DeleteAccountRequest">;
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

export type VaultItem =
	Schema<"CursorPage_VaultItemWithVaultResponse">["items"][number];
export type VaultItemDetails = Schema<"VaultItemDetailsResponse">;
export type DeletedVaultItem = Schema<"DeletedVaultItemWithVaultResponse">;
export type CreateItemInput = Schema<"CreateItemBody">;
export type CreateItemResponse = Schema<"CreateItemResponse">;
export type UpdateItemInput = Schema<"UpdateItemBody">;
export type UpdateItemResponse = Schema<"UpdateItemResponse">;
export type FavoriteInput = Schema<"FavoriteBody">;
export type MoveItemInput = Schema<"MoveItemBody">;

export type Attachment = Schema<"VaultAttachmentResponse">;
export type CreateAttachmentInput = Schema<"CreateAttachmentBody">;
export type CreateAttachmentResponse = Schema<"CreateAttachmentResponse">;
export type UpdateAttachmentInput = Schema<"UpdateAttachmentBody">;
export type AttachmentUploadInput = Schema<"AttachmentUploadBody">;
export type AttachmentDownload = Schema<"AttachmentDownloadResponse">;

export type AvailableTeamMember = Schema<"VaultAvailableMemberResponse">;
export type VaultMember = Schema<"VaultMemberResponse">;
export type AddVaultMemberInput = Schema<"AddVaultMemberBody">;
export type UpdateVaultMemberRoleInput = Schema<"UpdateVaultMemberRoleBody">;
export type RemoveVaultMemberInput = Schema<"RemoveVaultMemberBody">;
export type RemoveVaultMemberResponse = Schema<"RemoveVaultMemberResponse">;
export type VaultRotationData = Schema<"VaultRotationDataResponse">;

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
export type TeamLeaveInput = Schema<"TeamLeaveRequest">;
export type TeamRotationData = Schema<"RotationDataResponse">;
export type TeamMember = Schema<"TeamMemberResponse">;
export type RemoveTeamMemberInput = Schema<"RemoveTeamMemberRequest">;
export type RemoveTeamMemberResponse = Schema<"RemoveMemberResponse">;
export type TeamMemberAccess = Schema<"MemberAccessResponse">;
export type TeamVault = Schema<"TeamVaultResponse">;

export type CreateShareLinkInput = Schema<"CreateShareLinkRequest">;
export type CreateShareLinkResponse = Schema<"CreateShareLinkResponse">;
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
export type BillingStatus = Schema<"BillingStatusResponse">;
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
export interface AuditEventsRequest extends ApiPageRequest {
	from?: string;
	to?: string;
	actionGroup?: "auth" | "team" | "vault" | "item" | "share" | "other" | "all";
	actorUserId?: string;
	result?: "success" | "failure" | "all";
	search?: string;
}

export type SyncBootstrapPage = Schema<"BootstrapItemsResponse">;
export type SyncBootstrapItem = Schema<"BootstrapItemResponse">;
export type SyncEvent = Omit<Schema<"SyncEventResponse">, "timestamp"> & {
	timestamp: bigint;
};
export type SyncChanges = Omit<Schema<"SyncChangesResponse">, "events"> & {
	events: readonly SyncEvent[];
};
