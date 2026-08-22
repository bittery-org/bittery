import {
	type ApiMeta,
	type ApiVersionNegotiation,
	negotiateApiVersion,
	parseApiMeta,
} from "./api-meta.ts";
import type * as Final from "./facade-types.ts";
import type {
	AcceptTeamInvitationResponse,
	AddVaultMemberInput,
	ApiPage,
	ApiPageRequest,
	ApiResult,
	ApiWriteOptions,
	Attachment,
	AttachmentDownload,
	AttachmentUpload,
	AttachmentUploadInput,
	AuthUser,
	AuthVaultKey,
	AvailableTeamMember,
	BulkImportInput,
	BulkImportResponse,
	ConvertVaultInput,
	ConvertVaultResponse,
	CreateAttachmentInput,
	CreateAttachmentResponse,
	CreateItemInput,
	CreateItemOperationOutcome,
	CreateItemWriteOptions,
	CreateTeamInput,
	CreateVaultInput,
	CreateVaultResponse,
	DeleteAccountInput,
	DeletedVaultItem,
	EmailChangeInput,
	EmailCheckInput,
	EmailCheckResponse,
	FavoriteInput,
	FinishLoginInput,
	FinishLoginResponse,
	ImageUploadInput,
	ItemPayload,
	LoginAttempt,
	MoveItemInput,
	PasswordChangeInput,
	PendingTeamInvitation,
	PresignedUpload,
	PublicTeamInvitation,
	RecoveryData,
	RecoveryKeyInput,
	RecoverySessionInput,
	RecoveryVerificationInput,
	RefreshSessionResponse,
	RegistrationStatus,
	RenameSessionInput,
	ResendTeamInvitationResponse,
	ResetPasswordInput,
	ResetPasswordResponse,
	RotationPlanSet,
	RotationPlanSetFinalizeInput,
	RotationPlanSetFinalizeResponse,
	RotationPreparationPage,
	RotationStageInput,
	SecretKeyRotationInput,
	SendTeamInvitationInput,
	SendTeamInvitationResponse,
	Session,
	SignupInput,
	SignupResponse,
	SignupVerificationInput,
	StartLoginInput,
	SyncBootstrapPage,
	SyncBootstrapRequest,
	SyncChanges,
	SyncEvent,
	TeamDetails,
	TeamImageUploadInput,
	TeamInvitation,
	TeamMember,
	TeamMemberAccess,
	TeamSummary,
	TeamVault,
	UpdateAttachmentInput,
	UpdateItemInput,
	UpdateItemResponse,
	UpdateTeamInput,
	UpdateVaultInput,
	UpdateVaultMemberRoleInput,
	UpdateVaultResponse,
	Vault,
	VaultDetails,
	VaultItem,
	VaultItemDetails,
	VaultMember,
	VaultStats,
	VerifyRecoveryInput,
	VerifyRecoveryResponse,
	VerifySignupVerificationInput,
	VerifySignupVerificationResponse,
} from "./facade-types.ts";
import {
	type ApiAccessTokenProvider,
	type ApiClientMetadata,
	type ApiClientMetadataProvider,
	type ApiClientPlatform,
	type ApiFetch,
	type ApiHttpMethod,
	type ApiRequestOrigin,
	type ApiTransportData,
	type ApiTransportPath,
	type ApiTransportRequest,
	type ApiTransportRequestArguments,
	createApiTransport,
	type InsecureTransportAuthorizer,
	type InsecureTransportPolicy,
	requestOriginHeaders,
} from "./transport.ts";
import { parseDecimalString, parseRfc3339Utc } from "./value-codecs.ts";

export type {
	ApiAccessTokenProvider,
	ApiClientMetadata,
	ApiClientMetadataProvider,
	ApiClientPlatform,
	ApiFetch,
	ApiRequestOrigin,
	InsecureTransportAuthorizer,
	InsecureTransportPolicy,
};

export interface ApiClientOptions {
	serverUrl: string;
	insecureTransport?: InsecureTransportPolicy;
	authorizeInsecureTransport?: InsecureTransportAuthorizer;
	supportedApiMajors: readonly number[];
	fetch?: ApiFetch;
	getAccessToken?: ApiAccessTokenProvider;
	getClientMetadata: ApiClientMetadataProvider;
	onSessionExpires?: (expiresAt: string) => void | Promise<void>;
	onSessionRefreshRequired?: () => void | Promise<void>;
}

export interface ApiClient {
	readonly meta: {
		get(): Promise<ApiMeta>;
		negotiate(): Promise<ApiVersionNegotiation>;
	};
	readonly auth: {
		registrationStatus(): Promise<ApiResult<RegistrationStatus>>;
		checkEmail(input: EmailCheckInput): Promise<ApiResult<EmailCheckResponse>>;
		startLogin(input: StartLoginInput): Promise<ApiResult<LoginAttempt>>;
		finishLogin(
			attemptId: string,
			input: FinishLoginInput,
		): Promise<ApiResult<FinishLoginResponse>>;
		drainVaultKeys(
			accessToken: string,
			initialPage: ApiPage<AuthVaultKey>,
			requestOrigin: ApiRequestOrigin,
		): Promise<ApiResult<readonly AuthVaultKey[]>>;
		recoveryData(input: RecoverySessionInput): Promise<ApiResult<RecoveryData>>;
		resetPassword(
			input: ResetPasswordInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<ResetPasswordResponse>>;
		requestRecoveryVerification(
			input: RecoveryVerificationInput,
		): Promise<ApiResult<unknown>>;
		verifyRecovery(
			input: VerifyRecoveryInput,
		): Promise<ApiResult<VerifyRecoveryResponse>>;
		requestSignupVerification(
			input: SignupVerificationInput,
		): Promise<ApiResult<unknown>>;
		verifySignupVerification(
			input: VerifySignupVerificationInput,
		): Promise<ApiResult<VerifySignupVerificationResponse>>;
		signUp(
			input: SignupInput,
			requestOrigin: ApiRequestOrigin,
		): Promise<ApiResult<SignupResponse>>;
		me(): Promise<ApiResult<AuthUser>>;
		deleteAccount(
			input: DeleteAccountInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		changeEmail(
			input: EmailChangeInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		changePassword(
			input: PasswordChangeInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		storeRecoveryKey(
			input: RecoveryKeyInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		regenerateSecretKey(
			input: SecretKeyRotationInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		sessions: {
			list(): Promise<ApiResult<readonly Session[]>>;
			refresh(): Promise<ApiResult<RefreshSessionResponse>>;
			revoke(sessionId: string): Promise<ApiResult<unknown>>;
			rename(
				sessionId: string,
				input: RenameSessionInput,
			): Promise<ApiResult<unknown>>;
		};
	};
	readonly vaults: {
		list(): Promise<ApiResult<readonly Vault[]>>;
		get(vaultId: string): Promise<ApiResult<VaultDetails>>;
		create(
			vaultId: string,
			input: CreateVaultInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<CreateVaultResponse>>;
		update(
			vaultId: string,
			input: UpdateVaultInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<UpdateVaultResponse>>;
		remove(
			vaultId: string,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		stats(): Promise<ApiResult<VaultStats>>;
		createImageUpload(
			vaultId: string,
			input: ImageUploadInput,
		): Promise<ApiResult<PresignedUpload>>;
		convertType(
			vaultId: string,
			input: ConvertVaultInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<ConvertVaultResponse>>;
		importItems(
			vaultId: string,
			input: BulkImportInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<BulkImportResponse>>;
		members: {
			startRemovalRotation(
				vaultId: string,
				userId: string,
				options: ApiWriteOptions,
				signal?: AbortSignal,
			): Promise<ApiResult<RotationPlanSet>>;
			finalizeRemovalRotation(
				vaultId: string,
				userId: string,
				input: RotationPlanSetFinalizeInput,
				options: ApiWriteOptions,
				signal?: AbortSignal,
			): Promise<ApiResult<RotationPlanSetFinalizeResponse>>;
			list(vaultId: string): Promise<ApiResult<readonly VaultMember[]>>;
			add(
				vaultId: string,
				userId: string,
				input: AddVaultMemberInput,
				options?: ApiWriteOptions,
			): Promise<ApiResult<unknown>>;
			updateRole(
				vaultId: string,
				userId: string,
				input: UpdateVaultMemberRoleInput,
				options: ApiWriteOptions,
			): Promise<ApiResult<unknown>>;
		};
	};
	readonly items: {
		list(): Promise<ApiResult<readonly VaultItem[]>>;
		listTrashed(): Promise<ApiResult<readonly DeletedVaultItem[]>>;
		listInVault(
			vaultId: string,
			page?: ApiPageRequest,
		): Promise<ApiResult<readonly VaultItem[]>>;
		listTrashedInVault(
			vaultId: string,
			page?: ApiPageRequest,
		): Promise<ApiResult<readonly DeletedVaultItem[]>>;
		/**
		 * `GET /items/{itemId}` answers with `ItemResponseDto` — the item and nothing else.
		 * It used to be declared as {@link VaultItemDetails}, which promised `attachments`
		 * the endpoint has never sent; callers wanting those use `items.listAttachments`.
		 */
		get(itemId: string): Promise<ApiResult<ItemPayload>>;
		create(
			vaultId: string,
			itemId: string,
			input: CreateItemInput,
			options: CreateItemWriteOptions,
		): Promise<ApiResult<CreateItemOperationOutcome>>;
		update(
			itemId: string,
			input: UpdateItemInput,
			options: ApiWriteOptions,
		): Promise<ApiResult<UpdateItemResponse>>;
		setFavorite(
			itemId: string,
			input: FavoriteInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		move(
			itemId: string,
			input: MoveItemInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		trash(
			itemId: string,
			options: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		deletePermanently(
			itemId: string,
			options: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		restore(
			itemId: string,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
	};
	readonly operations: {
		get(operationId: string): Promise<ApiResult<CreateItemOperationOutcome>>;
	};
	readonly attachments: {
		list(itemId: string): Promise<ApiResult<readonly Attachment[]>>;
		create(
			itemId: string,
			input: CreateAttachmentInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<CreateAttachmentResponse>>;
		update(
			attachmentId: string,
			input: UpdateAttachmentInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		remove(
			attachmentId: string,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		createUpload(
			itemId: string,
			input: AttachmentUploadInput,
		): Promise<ApiResult<AttachmentUpload>>;
		createDownloadUrl(
			attachmentId: string,
		): Promise<ApiResult<AttachmentDownload>>;
	};
	readonly teams: {
		startLeaveRotation(
			teamId: string,
			options: ApiWriteOptions,
			signal?: AbortSignal,
		): Promise<ApiResult<RotationPlanSet>>;
		finalizeLeaveRotation(
			teamId: string,
			input: RotationPlanSetFinalizeInput,
			options: ApiWriteOptions,
			signal?: AbortSignal,
		): Promise<ApiResult<RotationPlanSetFinalizeResponse>>;
		create(
			input: CreateTeamInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		current(): Promise<ApiResult<TeamSummary>>;
		get(teamId: string): Promise<ApiResult<TeamDetails>>;
		update(
			teamId: string,
			input: UpdateTeamInput,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		remove(
			teamId: string,
			options?: ApiWriteOptions,
		): Promise<ApiResult<unknown>>;
		createImageUpload(
			teamId: string,
			input: TeamImageUploadInput,
		): Promise<ApiResult<PresignedUpload>>;
		availableMembersForVault(
			vaultId: string,
		): Promise<ApiResult<readonly AvailableTeamMember[]>>;
		invitations: {
			list(teamId: string): Promise<ApiResult<readonly TeamInvitation[]>>;
			send(
				teamId: string,
				input: SendTeamInvitationInput,
			): Promise<ApiResult<SendTeamInvitationResponse>>;
			cancel(
				teamId: string,
				invitationId: string,
				options?: ApiWriteOptions,
			): Promise<ApiResult<unknown>>;
			resend(
				teamId: string,
				invitationId: string,
			): Promise<ApiResult<ResendTeamInvitationResponse>>;
			mine(): Promise<ApiResult<readonly PendingTeamInvitation[]>>;
			acceptMine(
				invitationId: string,
			): Promise<ApiResult<AcceptTeamInvitationResponse>>;
			declineMine(
				invitationId: string,
				options?: ApiWriteOptions,
			): Promise<ApiResult<unknown>>;
			public(token: string): Promise<ApiResult<PublicTeamInvitation>>;
			acceptPublic(
				token: string,
			): Promise<ApiResult<AcceptTeamInvitationResponse>>;
			declinePublic(
				token: string,
				options?: ApiWriteOptions,
			): Promise<ApiResult<unknown>>;
		};
		members: {
			startRemovalRotation(
				teamId: string,
				userId: string,
				options: ApiWriteOptions,
				signal?: AbortSignal,
			): Promise<ApiResult<RotationPlanSet>>;
			finalizeRemovalRotation(
				teamId: string,
				userId: string,
				input: RotationPlanSetFinalizeInput,
				options: ApiWriteOptions,
				signal?: AbortSignal,
			): Promise<ApiResult<RotationPlanSetFinalizeResponse>>;
			list(teamId: string): Promise<ApiResult<readonly TeamMember[]>>;
			access(
				teamId: string,
				userId: string,
			): Promise<ApiResult<TeamMemberAccess>>;
		};
		vaults(teamId: string): Promise<ApiResult<readonly TeamVault[]>>;
	};
	readonly vaultKeyRotation: {
		preparationPage(
			planId: string,
			kind: string,
			cursor: string | null,
			signal?: AbortSignal,
		): Promise<ApiResult<RotationPreparationPage>>;
		stage(
			planId: string,
			kind: string,
			input: RotationStageInput,
			signal?: AbortSignal,
		): Promise<ApiResult<unknown>>;
		abandon(planId: string, signal?: AbortSignal): Promise<ApiResult<unknown>>;
	};
	readonly sync: {
		bootstrap(
			page?: SyncBootstrapRequest,
		): Promise<ApiResult<SyncBootstrapPage>>;
		changes(input?: {
			sinceId?: string;
			vaultIds?: readonly string[];
			limit?: number;
		}): Promise<ApiResult<SyncChanges>>;
		events(signal?: AbortSignal): Promise<Response>;
	};
	readonly share: {
		list(itemId: string): Promise<ApiResult<Final.ShareLinkList>>;
		create(
			itemId: string,
			input: Final.CreateShareLinkInput,
		): Promise<ApiResult<Final.CreateShareLinkResponse>>;
		remove(linkId: string): Promise<ApiResult<unknown>>;
		accessLogs(
			linkId: string,
		): Promise<ApiResult<readonly Final.ShareAccessLog[]>>;
		public(token: string): Promise<ApiResult<Final.PublicShareInfo>>;
		access(token: string): Promise<ApiResult<Final.PublicShareAccess>>;
		emailAccess(
			token: string,
			input: Final.EmailShareAccessInput,
		): Promise<ApiResult<Final.PublicShareAccess>>;
		verifyEmail(
			token: string,
			input: Final.EmailShareVerificationInput,
		): Promise<ApiResult<Final.EmailShareVerification>>;
	};
	readonly billing: {
		entitlements(): Promise<ApiResult<Final.BillingEntitlements>>;
		status(): Promise<ApiResult<Final.BillingStatusSummary>>;
		attachmentUsage(): Promise<ApiResult<Final.AttachmentUsage>>;
		checkout(
			input: Final.CheckoutSessionInput,
		): Promise<ApiResult<Final.CheckoutSession>>;
		portal(): Promise<ApiResult<Final.PortalSession>>;
		seatAdditionPreview(): Promise<
			ApiResult<Final.TeamSeatInvoicePreview | null>
		>;
	};
	readonly travelMode: {
		get(): Promise<ApiResult<Final.TravelMode>>;
		enable(
			input: Final.HiddenVaultsInput,
		): Promise<ApiResult<Final.TravelMode>>;
		disable(
			input: Final.DisableTravelModeInput,
		): Promise<ApiResult<Final.TravelMode>>;
		setHiddenVaults(
			input: Final.HiddenVaultsInput,
		): Promise<ApiResult<Final.TravelMode>>;
	};
	readonly audit: {
		list(
			input?: Final.AuditEventsRequest,
		): Promise<ApiResult<Final.AuditEvents>>;
	};
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${path} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${path} must be a non-empty string.`);
	}
	return value;
}

function boolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") {
		throw new TypeError(`${path} must be a boolean.`);
	}
	return value;
}

function writeHeaders(
	options: ApiWriteOptions | undefined,
): HeadersInit | undefined {
	if (!options) return undefined;
	const headers = new Headers();
	if (options.etag) headers.set("If-Match", options.etag);
	if (options.idempotencyKey) {
		headers.set("Idempotency-Key", options.idempotencyKey);
	}
	return headers;
}

function writeHeaderParams(options: ApiWriteOptions | undefined): {
	header: { "If-Match": string; "Idempotency-Key"?: string };
} {
	return {
		header: {
			"If-Match": options?.etag as string,
			...(options?.idempotencyKey
				? { "Idempotency-Key": options.idempotencyKey }
				: {}),
		},
	};
}

function validateLoginAttempt(value: unknown): LoginAttempt {
	const attempt = object(value, "/loginAttempt");
	string(attempt.attemptId, "/loginAttempt/attemptId");
	string(attempt.salt, "/loginAttempt/salt");
	string(attempt.serverPublicKey, "/loginAttempt/serverPublicKey");
	object(attempt.kdfParams, "/loginAttempt/kdfParams");
	return value as LoginAttempt;
}

function validateFinishLogin(value: unknown): FinishLoginResponse {
	const login = object(value, "/finishLogin");
	string(login.token, "/finishLogin/token");
	string(login.sessionId, "/finishLogin/sessionId");
	parseRfc3339Utc(login.expiresAt, "/finishLogin/expiresAt");
	string(login.serverProof, "/finishLogin/serverProof");
	object(login.user, "/finishLogin/user");
	validateVaultKeyPage(login.vaultKeys, "/finishLogin/vaultKeys");
	return value as FinishLoginResponse;
}

function validateVaultKeyPage(
	value: unknown,
	path: string,
): ApiPage<AuthVaultKey> {
	const page = object(value, path);
	if (!Array.isArray(page.items)) {
		throw new TypeError(`${path}/items must be an array.`);
	}
	boolean(page.hasMore, `${path}/hasMore`);
	if (page.nextCursor !== undefined && page.nextCursor !== null) {
		string(page.nextCursor, `${path}/nextCursor`);
	}
	return value as ApiPage<AuthVaultKey>;
}

function validateBootstrap(value: unknown): SyncBootstrapPage {
	const page = object(value, "/sync/bootstrap");
	if (!Array.isArray(page.items)) {
		throw new TypeError("/sync/bootstrap/items must be an array.");
	}
	boolean(page.hasMore, "/sync/bootstrap/hasMore");
	if (page.nextCursor !== undefined && page.nextCursor !== null) {
		string(page.nextCursor, "/sync/bootstrap/nextCursor");
	}
	if (page.syncCursor !== undefined && page.syncCursor !== null) {
		const cursor = object(page.syncCursor, "/sync/bootstrap/syncCursor");
		string(cursor.id, "/sync/bootstrap/syncCursor/id");
	}
	return value as SyncBootstrapPage;
}

function validateSyncChanges(value: unknown): SyncChanges {
	const page = object(value, "/sync/changes");
	if (!Array.isArray(page.events)) {
		throw new TypeError("/sync/changes/events must be an array.");
	}
	boolean(page.hasMore, "/sync/changes/hasMore");
	boolean(page.requiresFullRefresh, "/sync/changes/requiresFullRefresh");
	return {
		...(value as Omit<SyncChanges, "events">),
		events: page.events.map((event, index) => {
			const parsed = object(event, `/sync/changes/events/${index}`);
			string(parsed.id, `/sync/changes/events/${index}/id`);
			return {
				...(event as Omit<SyncEvent, "timestamp">),
				timestamp: parseDecimalString(
					parsed.timestamp,
					`/sync/changes/events/${index}/timestamp`,
				),
			};
		}),
	};
}

function validateSessions(value: unknown): readonly Session[] {
	if (!Array.isArray(value)) {
		throw new TypeError("/sessions must be an array.");
	}
	return value.map((entry, index) => {
		const session = object(entry, `/sessions/${index}`);
		return {
			...(entry as Omit<Session, "createdAt" | "lastActiveAt">),
			createdAt: parseRfc3339Utc(
				session.createdAt,
				`/sessions/${index}/createdAt`,
			),
			lastActiveAt: parseRfc3339Utc(
				session.lastActiveAt,
				`/sessions/${index}/lastActiveAt`,
			),
		};
	});
}

function validateVaultStats(value: unknown): VaultStats {
	const stats = object(value, "/vault-stats");
	return {
		...(value as Omit<VaultStats, "itemCount" | "vaultCount">),
		itemCount: parseDecimalString(stats.itemCount, "/vault-stats/itemCount"),
		vaultCount: parseDecimalString(stats.vaultCount, "/vault-stats/vaultCount"),
	};
}

function parseOptionalDecimalString(
	value: unknown,
	path: string,
): bigint | null | undefined {
	if (value === null || value === undefined) {
		return value;
	}
	return parseDecimalString(value, path);
}

function validateBillingEntitlements(
	value: unknown,
): Final.BillingEntitlements {
	const entitlements = object(value, "/billing/entitlements");
	const limits = object(entitlements.limits, "/billing/entitlements/limits");
	return {
		...(value as Omit<Final.BillingEntitlements, "limits">),
		limits: {
			...(limits as Omit<
				Final.BillingEntitlements["limits"],
				| "attachmentMaxFileSizeBytes"
				| "attachmentStorageBytes"
				| "shareLinks"
				| "sharedVaults"
			>),
			attachmentMaxFileSizeBytes: parseOptionalDecimalString(
				limits.attachmentMaxFileSizeBytes,
				"/billing/entitlements/limits/attachmentMaxFileSizeBytes",
			),
			attachmentStorageBytes: parseOptionalDecimalString(
				limits.attachmentStorageBytes,
				"/billing/entitlements/limits/attachmentStorageBytes",
			),
			shareLinks: parseOptionalDecimalString(
				limits.shareLinks,
				"/billing/entitlements/limits/shareLinks",
			),
			sharedVaults: parseOptionalDecimalString(
				limits.sharedVaults,
				"/billing/entitlements/limits/sharedVaults",
			),
		},
	};
}

function validateAttachmentUsage(value: unknown): Final.AttachmentUsage {
	const usage = object(value, "/billing/attachment-usage");
	return {
		...(value as Omit<
			Final.AttachmentUsage,
			"committedStorageBytes" | "quotaBytes"
		>),
		committedStorageBytes: parseDecimalString(
			usage.committedStorageBytes,
			"/billing/attachment-usage/committedStorageBytes",
		),
		quotaBytes: parseOptionalDecimalString(
			usage.quotaBytes,
			"/billing/attachment-usage/quotaBytes",
		),
	};
}

/**
 * The facade is deliberately the only public transport entry point, so clients cannot
 * couple screens to generated paths or openapi-fetch's request shape.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
	const transport = createApiTransport({
		baseUrl: options.serverUrl,
		insecureTransport: options.insecureTransport,
		authorizeInsecureTransport: options.authorizeInsecureTransport,
		fetch: options.fetch,
		getAccessToken: options.getAccessToken,
		getClientMetadata: options.getClientMetadata,
		onSessionExpires: options.onSessionExpires,
		onSessionRefreshRequired: options.onSessionRefreshRequired,
	});

	async function call<
		Method extends ApiHttpMethod,
		Path extends ApiTransportPath<Method>,
	>(
		method: Method,
		path: Path,
		...request: ApiTransportRequestArguments<Method, Path>
	): Promise<ApiResult<ApiTransportData<Method, Path>>> {
		const result = await transport.request(method, path, ...request);
		return {
			data: result.data,
			etag: result.etag,
			requestId: result.requestId,
		};
	}

	type PaginatedPath = {
		[Path in ApiTransportPath<"GET">]: ApiTransportData<"GET", Path> extends {
			items: readonly unknown[];
			hasMore: boolean;
			nextCursor?: string | null;
		}
			? Path
			: never;
	}[ApiTransportPath<"GET">];
	type PageItem<Path extends PaginatedPath> =
		ApiTransportData<"GET", Path> extends { items: readonly (infer Item)[] }
			? Item
			: never;
	type Page<Path extends PaginatedPath> = {
		items: readonly PageItem<Path>[];
		hasMore: boolean;
		nextCursor?: string | null;
	};

	async function drainPages<Path extends PaginatedPath>(
		path: Path,
		...requestArguments: ApiTransportRequestArguments<"GET", Path>
	): Promise<ApiResult<readonly PageItem<Path>[]>> {
		const request = requestArguments[0];
		const query = (request?.params?.query ?? {}) as Record<string, unknown>;
		let cursor = typeof query.cursor === "string" ? query.cursor : undefined;
		let latest: ApiResult<ApiTransportData<"GET", Path>> | undefined;
		const items: PageItem<Path>[] = [];
		const seenCursors = new Set<string>();

		do {
			const pageRequest = {
				...request,
				params: {
					...request?.params,
					query: { ...query, cursor },
				},
			} as Exclude<ApiTransportRequest<"GET", Path>, undefined>;
			latest = await call(
				"GET",
				path,
				...([pageRequest] as ApiTransportRequestArguments<"GET", Path>),
			);
			const page = latest.data as Page<Path>;
			items.push(...(page.items as readonly PageItem<Path>[]));
			const nextCursor = page.nextCursor ?? undefined;
			if (page.hasMore && !nextCursor) {
				throw new TypeError(`${path} returned hasMore without a nextCursor.`);
			}
			if (nextCursor && seenCursors.has(nextCursor)) {
				throw new TypeError(`${path} returned a repeated nextCursor.`);
			}
			if (nextCursor) {
				seenCursors.add(nextCursor);
			}
			cursor = page.hasMore ? nextCursor : undefined;
		} while (cursor);

		return {
			data: items,
			etag: latest?.etag ?? null,
			requestId: latest?.requestId ?? null,
		};
	}

	async function drainIssuedVaultKeys(
		accessToken: string,
		initialPage: ApiPage<AuthVaultKey>,
		requestOrigin: ApiRequestOrigin,
	): Promise<ApiResult<readonly AuthVaultKey[]>> {
		const items = [...initialPage.items];
		let cursor = initialPage.hasMore
			? (initialPage.nextCursor ?? undefined)
			: undefined;
		if (initialPage.hasMore && !cursor) {
			throw new TypeError(
				"/finishLogin/vaultKeys returned hasMore without a nextCursor.",
			);
		}
		const seenCursors = new Set<string>();
		let latest: ApiResult<ApiPage<AuthVaultKey>> | undefined;
		while (cursor) {
			if (seenCursors.has(cursor)) {
				throw new TypeError(
					"/api/v1/users/me/vault-keys returned a repeated nextCursor.",
				);
			}
			seenCursors.add(cursor);
			const wirePage = await call("GET", "/api/v1/users/me/vault-keys", {
				headers: new Headers({
					...Object.fromEntries(requestOriginHeaders(requestOrigin)),
					Authorization: `Bearer ${accessToken}`,
				}),
				params: { query: { cursor } },
			});
			latest = wirePage;
			const page = validateVaultKeyPage(wirePage.data, "/users/me/vault-keys");
			items.push(...page.items);
			cursor = page.hasMore ? (page.nextCursor ?? undefined) : undefined;
			if (page.hasMore && !cursor) {
				throw new TypeError(
					"/api/v1/users/me/vault-keys returned hasMore without a nextCursor.",
				);
			}
		}
		return {
			data: items,
			etag: latest?.etag ?? null,
			requestId: latest?.requestId ?? null,
		};
	}

	type WireActiveItem = Omit<VaultItem, "attachments"> & {
		attachments?: readonly Attachment[] | null;
	};

	type ActiveItemsPath = "/api/v1/items" | "/api/v1/vaults/{vaultId}/items";
	async function drainActiveItems<Path extends ActiveItemsPath>(
		path: Path,
		...request: ApiTransportRequestArguments<"GET", Path>
	): Promise<ApiResult<readonly VaultItem[]>> {
		const result = await drainPages(path, ...request);
		const items = result.data as readonly WireActiveItem[];
		return {
			...result,
			data: items.map((item, index) => {
				if (!Array.isArray(item.attachments)) {
					throw new TypeError(
						`${path}/items/${index}/attachments must be an array for an active item.`,
					);
				}
				return { ...item, attachments: item.attachments };
			}),
		};
	}

	async function getMetadata(): Promise<ApiMeta> {
		const result = await transport.getApiMetadata();
		return parseApiMeta(result.data);
	}

	const client: ApiClient = {
		meta: {
			get: getMetadata,
			async negotiate() {
				return negotiateApiVersion(
					await getMetadata(),
					options.supportedApiMajors,
				);
			},
		},
		auth: {
			registrationStatus: () => call("GET", "/api/v1/auth/registration-status"),
			checkEmail: (input) =>
				call("POST", "/api/v1/auth/email-checks", { body: input }),
			async startLogin(input) {
				const result = await call("POST", "/api/v1/auth/login-attempts", {
					body: input,
				});
				return { ...result, data: validateLoginAttempt(result.data) };
			},
			async finishLogin(attemptId, input) {
				const result = await call(
					"POST",
					"/api/v1/auth/login-attempts/{attemptId}/finish",
					{ params: { path: { attemptId } }, body: input },
				);
				return { ...result, data: validateFinishLogin(result.data) };
			},
			drainVaultKeys: drainIssuedVaultKeys,
			recoveryData: (input) =>
				call("POST", "/api/v1/auth/recovery-sessions/data", { body: input }),
			resetPassword: (input, write) =>
				call("POST", "/api/v1/auth/recovery-sessions/reset-password", {
					body: input,
					headers: writeHeaders(write),
				}),
			requestRecoveryVerification: (input) =>
				call("POST", "/api/v1/auth/recovery-verifications", { body: input }),
			verifyRecovery: (input) =>
				call("POST", "/api/v1/auth/recovery-verifications/verify", {
					body: input,
				}),
			requestSignupVerification: (input) =>
				call("POST", "/api/v1/auth/signup-verifications", { body: input }),
			verifySignupVerification: (input) =>
				call("POST", "/api/v1/auth/signup-verifications/verify", {
					body: input,
				}),
			async signUp(input, requestOrigin) {
				const result = await call("POST", "/api/v1/auth/signups", {
					body: input,
				});
				const signup = object(result.data, "/signup");
				const token = string(signup.token, "/signup/token");
				const initialPage = validateVaultKeyPage(
					signup.vaultKeys,
					"/signup/vaultKeys",
				);
				const vaultKeys = await drainIssuedVaultKeys(
					token,
					initialPage,
					requestOrigin,
				);
				return {
					...result,
					data: { ...signup, vaultKeys: vaultKeys.data } as SignupResponse,
				};
			},
			me: () => call("GET", "/api/v1/users/me"),
			deleteAccount: (input, write) =>
				call("DELETE", "/api/v1/users/me", {
					body: input,
					headers: writeHeaders(write),
				}),
			changeEmail: (input, write) =>
				call("POST", "/api/v1/users/me/email-changes", {
					body: input,
					headers: writeHeaders(write),
				}),
			changePassword: (input, write) =>
				call("POST", "/api/v1/users/me/password-changes", {
					body: input,
					headers: writeHeaders(write),
				}),
			storeRecoveryKey: (input, write) =>
				call("PUT", "/api/v1/users/me/recovery-key", {
					body: input,
					headers: writeHeaders(write),
				}),
			regenerateSecretKey: (input, write) =>
				call("POST", "/api/v1/users/me/secret-key-rotations", {
					body: input,
					headers: writeHeaders(write),
				}),
			sessions: {
				async list() {
					const result = await drainPages("/api/v1/sessions");
					return { ...result, data: validateSessions(result.data) };
				},
				refresh: () => call("POST", "/api/v1/sessions/current/refresh"),
				revoke: (sessionId) =>
					call("DELETE", "/api/v1/sessions/{sessionId}", {
						params: { path: { sessionId } },
					}),
				rename: (sessionId, input) =>
					call("PATCH", "/api/v1/sessions/{sessionId}", {
						params: { path: { sessionId } },
						body: input,
					}),
			},
		},
		vaults: {
			list: () => drainPages("/api/v1/vaults"),
			get: (vaultId) =>
				call("GET", "/api/v1/vaults/{vaultId}", {
					params: { path: { vaultId } },
				}),
			create: (vaultId, input, write) =>
				call("PUT", "/api/v1/vaults/{vaultId}", {
					params: { path: { vaultId } },
					body: input,
					headers: writeHeaders(write),
				}),
			update: (vaultId, input, write) =>
				call("PATCH", "/api/v1/vaults/{vaultId}", {
					params: { path: { vaultId } },
					body: input,
					headers: writeHeaders(write),
				}),
			remove: (vaultId, write) =>
				call("DELETE", "/api/v1/vaults/{vaultId}", {
					params: { path: { vaultId } },
					headers: writeHeaders(write),
				}),
			async stats() {
				const result = await call("GET", "/api/v1/vault-stats");
				return { ...result, data: validateVaultStats(result.data) };
			},
			createImageUpload: (vaultId, input) =>
				call("POST", "/api/v1/vaults/{vaultId}/image-uploads", {
					params: { path: { vaultId } },
					body: input,
				}),
			convertType: (vaultId, input, write) =>
				call("POST", "/api/v1/vaults/{vaultId}/type-conversions", {
					params: { path: { vaultId } },
					body: input,
					headers: writeHeaders(write),
				}),
			importItems: (vaultId, input, write) =>
				call("POST", "/api/v1/vaults/{vaultId}/item-imports", {
					params: { path: { vaultId } },
					body: input,
					headers: writeHeaders(write),
				}),
			members: {
				startRemovalRotation: (vaultId, userId, write, signal) =>
					call(
						"POST",
						"/api/v1/vaults/{vaultId}/members/{userId}/removal-rotation-plans",
						{
							params: { path: { vaultId, userId } },
							headers: writeHeaders(write),
							signal,
						},
					),
				finalizeRemovalRotation: (vaultId, userId, input, write, signal) =>
					call(
						"POST",
						"/api/v1/vaults/{vaultId}/members/{userId}/removal-rotation-plans/finalize",
						{
							params: { path: { vaultId, userId } },
							body: input,
							headers: writeHeaders(write),
							signal,
						},
					),
				list: (vaultId) =>
					drainPages("/api/v1/vaults/{vaultId}/members", {
						params: { path: { vaultId } },
					}),
				add: (vaultId, userId, input, write) =>
					call("PUT", "/api/v1/vaults/{vaultId}/members/{userId}", {
						params: { path: { vaultId, userId } },
						body: input,
						headers: writeHeaders(write),
					}),
				updateRole: (vaultId, userId, input, write) =>
					call("PATCH", "/api/v1/vaults/{vaultId}/members/{userId}", {
						params: { path: { vaultId, userId } },
						body: input,
						headers: writeHeaders(write),
					}),
			},
		},
		items: {
			list: () => drainActiveItems("/api/v1/items"),
			listTrashed: () => drainPages("/api/v1/items/trashed"),
			listInVault: (vaultId, page) =>
				drainActiveItems("/api/v1/vaults/{vaultId}/items", {
					params: { path: { vaultId }, query: page },
				}),
			listTrashedInVault: (vaultId, page) =>
				drainPages("/api/v1/vaults/{vaultId}/items/trashed", {
					params: { path: { vaultId }, query: page },
				}),
			get: (itemId) =>
				call("GET", "/api/v1/items/{itemId}", { params: { path: { itemId } } }),
			create: (vaultId, itemId, input, write) =>
				call("PUT", "/api/v1/vaults/{vaultId}/items/{itemId}", {
					params: {
						path: { vaultId, itemId },
						header: { "Idempotency-Key": write.idempotencyKey },
					},
					body: input,
					headers: writeHeaders(write),
				}),
			update: (itemId, input, write) =>
				call("PATCH", "/api/v1/items/{itemId}", {
					params: { path: { itemId }, ...writeHeaderParams(write) },
					body: input,
					headers: writeHeaders(write),
				}),
			setFavorite: (itemId, input, write) =>
				call("PATCH", "/api/v1/items/{itemId}/favorite", {
					params: { path: { itemId }, ...writeHeaderParams(write) },
					body: input,
					headers: writeHeaders(write),
				}),
			move: (itemId, input, write) =>
				call("POST", "/api/v1/items/{itemId}/moves", {
					params: { path: { itemId }, ...writeHeaderParams(write) },
					body: input,
					headers: writeHeaders(write),
				}),
			trash: (itemId, write) =>
				call("DELETE", "/api/v1/items/{itemId}", {
					params: { path: { itemId }, ...writeHeaderParams(write) },
					headers: writeHeaders(write),
				}),
			deletePermanently: (itemId, write) =>
				call("DELETE", "/api/v1/items/{itemId}/permanent", {
					params: { path: { itemId }, ...writeHeaderParams(write) },
					headers: writeHeaders(write),
				}),
			restore: (itemId, write) =>
				call("POST", "/api/v1/items/{itemId}/restore", {
					params: { path: { itemId }, ...writeHeaderParams(write) },
					headers: writeHeaders(write),
				}),
		},
		operations: {
			get: (operationId) =>
				call("GET", "/api/v1/operations/{operationId}", {
					params: { path: { operationId } },
				}),
		},
		attachments: {
			list: (itemId) =>
				drainPages("/api/v1/items/{itemId}/attachments", {
					params: { path: { itemId } },
				}),
			create: (itemId, input, write) =>
				call("POST", "/api/v1/items/{itemId}/attachments", {
					params: { path: { itemId } },
					body: input,
					headers: writeHeaders(write),
				}),
			update: (attachmentId, input, write) =>
				call("PATCH", "/api/v1/attachments/{attachmentId}", {
					params: { path: { attachmentId } },
					body: input,
					headers: writeHeaders(write),
				}),
			remove: (attachmentId, write) =>
				call("DELETE", "/api/v1/attachments/{attachmentId}", {
					params: { path: { attachmentId } },
					headers: writeHeaders(write),
				}),
			createUpload: (itemId, input) =>
				call("POST", "/api/v1/items/{itemId}/attachment-uploads", {
					params: { path: { itemId } },
					body: input,
				}),
			createDownloadUrl: (attachmentId) =>
				call("POST", "/api/v1/attachments/{attachmentId}/download-urls", {
					params: { path: { attachmentId } },
				}),
		},
		teams: {
			startLeaveRotation: (teamId, write, signal) =>
				call("POST", "/api/v1/teams/{teamId}/leave-rotation-plans", {
					params: { path: { teamId } },
					headers: writeHeaders(write),
					signal,
				}),
			finalizeLeaveRotation: (teamId, input, write, signal) =>
				call("POST", "/api/v1/teams/{teamId}/leave-rotation-plans/finalize", {
					params: { path: { teamId } },
					body: input,
					headers: writeHeaders(write),
					signal,
				}),
			create: (input, write) =>
				call("POST", "/api/v1/teams", {
					body: input,
					headers: writeHeaders(write),
				}),
			current: () => call("GET", "/api/v1/teams/current"),
			get: (teamId) =>
				call("GET", "/api/v1/teams/{teamId}", {
					params: { path: { teamId } },
				}),
			update: (teamId, input, write) =>
				call("PATCH", "/api/v1/teams/{teamId}", {
					params: { path: { teamId } },
					body: input,
					headers: writeHeaders(write),
				}),
			remove: (teamId, write) =>
				call("DELETE", "/api/v1/teams/{teamId}", {
					params: { path: { teamId } },
					headers: writeHeaders(write),
				}),
			createImageUpload: (teamId, input) =>
				call("POST", "/api/v1/teams/{teamId}/image-uploads", {
					params: { path: { teamId } },
					body: input,
				}),
			availableMembersForVault: (vaultId) =>
				drainPages("/api/v1/vaults/{vaultId}/available-team-members", {
					params: { path: { vaultId } },
				}),
			invitations: {
				list: (teamId) =>
					drainPages("/api/v1/teams/{teamId}/invitations", {
						params: { path: { teamId } },
					}),
				send: (teamId, input) =>
					call("POST", "/api/v1/teams/{teamId}/invitations", {
						params: { path: { teamId } },
						body: input,
					}),
				cancel: (teamId, invitationId, write) =>
					call("DELETE", "/api/v1/teams/{teamId}/invitations/{invitationId}", {
						params: { path: { teamId, invitationId } },
						headers: writeHeaders(write),
					}),
				resend: (teamId, invitationId) =>
					call(
						"POST",
						"/api/v1/teams/{teamId}/invitations/{invitationId}/resend",
						{
							params: { path: { teamId, invitationId } },
						},
					),
				mine: () => drainPages("/api/v1/users/me/team-invitations"),
				acceptMine: (invitationId) =>
					call(
						"POST",
						"/api/v1/users/me/team-invitations/{invitationId}/accept",
						{
							params: { path: { invitationId } },
						},
					),
				declineMine: (invitationId, write) =>
					call(
						"POST",
						"/api/v1/users/me/team-invitations/{invitationId}/decline",
						{
							params: { path: { invitationId } },
							headers: writeHeaders(write),
						},
					),
				public: (token) =>
					call("GET", "/api/v1/public/team-invitations/{token}", {
						params: { path: { token } },
					}),
				acceptPublic: (token) =>
					call("POST", "/api/v1/public/team-invitations/{token}/accept", {
						params: { path: { token } },
					}),
				declinePublic: (token, write) =>
					call("POST", "/api/v1/public/team-invitations/{token}/decline", {
						params: { path: { token } },
						headers: writeHeaders(write),
					}),
			},
			members: {
				startRemovalRotation: (teamId, userId, write, signal) =>
					call(
						"POST",
						"/api/v1/teams/{teamId}/members/{userId}/removal-rotation-plans",
						{
							params: { path: { teamId, userId } },
							headers: writeHeaders(write),
							signal,
						},
					),
				finalizeRemovalRotation: (teamId, userId, input, write, signal) =>
					call(
						"POST",
						"/api/v1/teams/{teamId}/members/{userId}/removal-rotation-plans/finalize",
						{
							params: { path: { teamId, userId } },
							body: input,
							headers: writeHeaders(write),
							signal,
						},
					),
				list: (teamId) =>
					drainPages("/api/v1/teams/{teamId}/members", {
						params: { path: { teamId } },
					}),
				access: (teamId, userId) =>
					call("GET", "/api/v1/teams/{teamId}/members/{userId}/access", {
						params: { path: { teamId, userId } },
					}),
			},
			vaults: (teamId) =>
				drainPages("/api/v1/teams/{teamId}/vaults", {
					params: { path: { teamId } },
				}),
		},
		vaultKeyRotation: {
			preparationPage: (planId, kind, cursor, signal) =>
				call(
					"GET",
					"/api/v1/vault-key-rotation-plans/{planId}/preparation/{kind}",
					{
						params: {
							path: { planId, kind },
							query: { cursor: cursor ?? undefined },
						},
						signal,
					},
				),
			stage: (planId, kind, input, signal) =>
				call("PUT", "/api/v1/vault-key-rotation-plans/{planId}/staged/{kind}", {
					params: { path: { planId, kind } },
					body: input,
					signal,
				}),
			abandon: (planId, signal) =>
				call("DELETE", "/api/v1/vault-key-rotation-plans/{planId}", {
					params: { path: { planId } },
					signal,
				}),
		},
		sync: {
			async bootstrap(page) {
				const result = await call("GET", "/api/v1/sync/bootstrap", {
					params: { query: page },
				});
				return { ...result, data: validateBootstrap(result.data) };
			},
			async changes(input) {
				const result = await call("GET", "/api/v1/sync/changes", {
					params: { query: input },
				});
				return { ...result, data: validateSyncChanges(result.data) };
			},
			events: (signal) => transport.openSyncEvents(signal),
		},
		share: {
			list: (itemId) =>
				call("GET", "/api/v1/items/{itemId}/share-links", {
					params: { path: { itemId } },
				}),
			create: (itemId, input) =>
				call("POST", "/api/v1/items/{itemId}/share-links", {
					params: { path: { itemId } },
					body: input,
				}),
			remove: (linkId) =>
				call("DELETE", "/api/v1/share-links/{linkId}", {
					params: { path: { linkId } },
				}),
			accessLogs: (linkId) =>
				drainPages("/api/v1/share-links/{linkId}/access-logs", {
					params: { path: { linkId } },
				}),
			public: (token) =>
				call("GET", "/api/v1/public/share-links/{token}", {
					params: { path: { token } },
				}),
			access: (token) =>
				call("POST", "/api/v1/public/share-links/{token}/accesses", {
					params: { path: { token } },
				}),
			emailAccess: (token, input) =>
				call("POST", "/api/v1/public/share-links/{token}/email-accesses", {
					params: { path: { token } },
					body: input,
				}),
			verifyEmail: (token, input) =>
				call("POST", "/api/v1/public/share-links/{token}/email-verifications", {
					params: { path: { token } },
					body: input,
				}),
		},
		billing: {
			async entitlements() {
				const result = await call("GET", "/api/v1/billing/entitlements");
				return { ...result, data: validateBillingEntitlements(result.data) };
			},
			status: () => call("GET", "/api/v1/billing/status"),
			async attachmentUsage() {
				const result = await call("GET", "/api/v1/billing/attachment-usage");
				return { ...result, data: validateAttachmentUsage(result.data) };
			},
			checkout: (input) =>
				call("POST", "/api/v1/billing/checkout-sessions", { body: input }),
			portal: () => call("POST", "/api/v1/billing/portal-sessions"),
			seatAdditionPreview: () =>
				call("GET", "/api/v1/billing/team-seats/addition-preview"),
		},
		travelMode: {
			get: () => call("GET", "/api/v1/travel-mode"),
			enable: (input) =>
				call("POST", "/api/v1/travel-mode/enable", { body: input }),
			disable: (input) =>
				call("POST", "/api/v1/travel-mode/disable", { body: input }),
			setHiddenVaults: (input) =>
				call("PUT", "/api/v1/travel-mode/hidden-vaults", { body: input }),
		},
		audit: {
			list: (input) =>
				call("GET", "/api/v1/audit-events", { params: { query: input } }),
		},
	};

	return client;
}
