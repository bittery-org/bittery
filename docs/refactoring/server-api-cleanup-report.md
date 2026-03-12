# Server and API Refactoring Review

Scope reviewed:

- `apps/server/src`
- `packages/api/src`

Excluded on purpose:

- Crypto/security-sensitive code paths such as `apps/server/src/security.ts` and the crypto packages.

No source files were modified. The snippets below are proposed refactors only.

## 1. Extract the duplicated attachment entitlement lookup

**File paths**

- `packages/api/src/routers/sync.ts`
- `packages/api/src/routers/vault.ts`

**Why**

The same `canUseAttachments` logic exists in two routers. That makes billing behavior harder to change safely and spreads the same cloud/self-hosted fallback logic in multiple places.

**Current code**

```ts
// packages/api/src/routers/sync.ts
async function canUseAttachments(userId: string): Promise<boolean> {
	const userData = await db.query.user.findFirst({
		where: (user, { eq: eqFn }) => eqFn(user.id, userId),
		with: { team: true },
	});
	const mode = getBitteryMode();

	// In cloud mode, fail closed for orphaned users with no team linkage.
	if (!userData?.team) {
		return mode === "self-hosted";
	}

	const entitlements = resolveEffectiveEntitlements({
		mode,
		billingPlan: userData.team.billingPlan,
		billingStatus: userData.team.billingStatus,
	});

	return entitlements.attachments;
}
```

```ts
// packages/api/src/routers/vault.ts
async function canUseAttachments(userId: string): Promise<boolean> {
	const userData = await db.query.user.findFirst({
		where: (user, { eq: eqFn }) => eqFn(user.id, userId),
		with: { team: true },
	});
	const mode = getBitteryMode();

	// In cloud mode, fail closed for orphaned users with no team linkage.
	if (!userData?.team) {
		return mode === "self-hosted";
	}

	const entitlements = resolveEffectiveEntitlements({
		mode,
		billingPlan: userData.team.billingPlan,
		billingStatus: userData.team.billingStatus,
	});

	return entitlements.attachments;
}
```

**Improved version**

```ts
// packages/api/src/helpers/entitlements.ts
export async function canUserUseAttachments(userId: string): Promise<boolean> {
	const actor = await db.query.user.findFirst({
		where: (user, { eq: eqFn }) => eqFn(user.id, userId),
		with: { team: true },
	});
	const mode = getBitteryMode();

	if (!actor?.team) {
		return mode === "self-hosted";
	}

	return resolveEffectiveEntitlements({
		mode,
		billingPlan: actor.team.billingPlan,
		billingStatus: actor.team.billingStatus,
	}).attachments;
}
```

```ts
// packages/api/src/routers/sync.ts
const attachmentsEnabled = await canUserUseAttachments(ctx.session.userId);

// packages/api/src/routers/vault.ts
const attachmentsEnabled = await canUserUseAttachments(ctx.session.userId);
```

## 2. Flatten the nested entitlement guard in `vault.ts`

**File path**

- `packages/api/src/routers/vault.ts`

**Why**

`assertUserEntitlement` mixes orphan handling, self-hosted behavior, and error throwing in a nested branch. It also repeats the same `TRPCError` construction twice.

**Current code**

```ts
async function assertUserEntitlement(
	userId: string,
	entitlement: EntitlementKey,
	message: string,
) {
	const userData = await db.query.user.findFirst({
		where: (user, { eq: eqFn }) => eqFn(user.id, userId),
		with: { team: true },
	});
	const mode = getBitteryMode();

	// In cloud mode, fail closed for orphaned users with no team linkage.
	if (!userData?.team) {
		if (mode === "self-hosted") {
			return;
		}
		throw new TRPCError({
			code: "FORBIDDEN",
			message,
		});
	}

	const entitlements = resolveEffectiveEntitlements({
		mode,
		billingPlan: userData.team.billingPlan,
		billingStatus: userData.team.billingStatus,
	});

	if (!entitlements[entitlement]) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message,
		});
	}
}
```

**Improved version**

```ts
function throwForbidden(message: string): never {
	throw new TRPCError({
		code: "FORBIDDEN",
		message,
	});
}

async function assertUserEntitlement(
	userId: string,
	entitlement: EntitlementKey,
	message: string,
) {
	const actor = await db.query.user.findFirst({
		where: (user, { eq: eqFn }) => eqFn(user.id, userId),
		with: { team: true },
	});
	const mode = getBitteryMode();

	if (!actor?.team) {
		if (mode === "self-hosted") return;
		throwForbidden(message);
	}

	const allowed = resolveEffectiveEntitlements({
		mode,
		billingPlan: actor.team.billingPlan,
		billingStatus: actor.team.billingStatus,
	})[entitlement];

	if (!allowed) {
		throwForbidden(message);
	}
}
```

## 3. Collapse repeated billing snapshot assembly into helpers

**File path**

- `packages/api/src/routers/billing.ts`

**Why**

`entitlements`, `attachmentUsage`, and `createPortalSession` all recompute the same billing snapshot pieces inline. `status` also returns a large self-hosted object literal directly from the route. Extracting small helpers would make the router easier to scan and lower repetition.

**Current code**

```ts
status: protectedProcedure.query(async ({ ctx }) => {
	if (isSelfHostedMode()) {
		return {
			enabled: false,
			plan: "free" as CloudPlanId,
			status: "none" as const,
			isActive: false,
			requiresPayment: false,
			isStripeConfigured: false,
			stripeCustomerId: null as string | null,
			stripeSubscriptionId: null as string | null,
			stripePriceId: null as string | null,
			currentPeriodEnd: null as Date | null,
			cancelAtPeriodEnd: false,
			seatsPurchased: null as number | null,
		};
	}

	const actor = await getBillingActor(ctx.session.userId);
	const requiresPayment = actor.team.billingPlan !== "free";

	return {
		enabled: true,
		plan: actor.team.billingPlan,
		status: actor.team.billingStatus,
		isActive: isBillingActive(actor.team.billingStatus),
		requiresPayment,
		isStripeConfigured: isStripeApiConfigured(),
		stripeCustomerId: actor.team.stripeCustomerId,
		stripeSubscriptionId: actor.team.stripeSubscriptionId,
		stripePriceId: actor.team.stripePriceId,
		currentPeriodEnd: actor.team.currentPeriodEnd,
		cancelAtPeriodEnd: actor.team.cancelAtPeriodEnd,
		seatsPurchased: actor.team.seatsPurchased,
	};
}),
```

```ts
const entitlements = resolveEffectiveEntitlements({
	mode,
	billingPlan: actor.team.billingPlan,
	billingStatus: actor.team.billingStatus,
});
const limits = resolveEffectiveEntitlementLimits(
	{
		mode,
		billingPlan: actor.team.billingPlan,
		billingStatus: actor.team.billingStatus,
	},
	entitlements,
);
```

**Improved version**

```ts
const SELF_HOSTED_BILLING_STATUS = {
	enabled: false,
	plan: "free" as CloudPlanId,
	status: "none" as const,
	isActive: false,
	requiresPayment: false,
	isStripeConfigured: false,
	stripeCustomerId: null as string | null,
	stripeSubscriptionId: null as string | null,
	stripePriceId: null as string | null,
	currentPeriodEnd: null as Date | null,
	cancelAtPeriodEnd: false,
	seatsPurchased: null as number | null,
};

function getBillingSnapshot(
	mode: ReturnType<typeof getBitteryMode>,
	actor: Awaited<ReturnType<typeof getBillingActor>>,
) {
	const input = {
		mode,
		billingPlan: actor.team.billingPlan,
		billingStatus: actor.team.billingStatus,
	} as const;
	const entitlements = resolveEffectiveEntitlements(input);

	return {
		input,
		entitlements,
		limits: resolveEffectiveEntitlementLimits(input, entitlements),
	};
}

status: protectedProcedure.query(async ({ ctx }) => {
	if (isSelfHostedMode()) {
		return SELF_HOSTED_BILLING_STATUS;
	}

	const actor = await getBillingActor(ctx.session.userId);

	return {
		enabled: true,
		plan: actor.team.billingPlan,
		status: actor.team.billingStatus,
		isActive: isBillingActive(actor.team.billingStatus),
		requiresPayment: actor.team.billingPlan !== "free",
		isStripeConfigured: isStripeApiConfigured(),
		stripeCustomerId: actor.team.stripeCustomerId,
		stripeSubscriptionId: actor.team.stripeSubscriptionId,
		stripePriceId: actor.team.stripePriceId,
		currentPeriodEnd: actor.team.currentPeriodEnd,
		cancelAtPeriodEnd: actor.team.cancelAtPeriodEnd,
		seatsPurchased: actor.team.seatsPurchased,
	};
}),

const { entitlements, limits } = getBillingSnapshot(mode, actor);
```

## 4. Remove the mutable full-refresh flag in `getEventsSince`

**File path**

- `packages/api/src/routers/sync.ts`

**Why**

`getEventsSince` uses `sinceSeq` plus a separate mutable `requiresFullRefresh` flag, then branches later. This is harder to follow than an early-return flow.

**Current code**

```ts
let sinceSeq = 0;
let requiresFullRefresh = false;
if (input.sinceId) {
	const cursorEvent = await db.query.syncEvent.findFirst({
		where: and(eq(syncEvent.id, input.sinceId), visibleEventsWhere),
		columns: {
			id: true,
			seq: true,
		},
	});

	if (!cursorEvent) {
		requiresFullRefresh = true;
	} else {
		sinceSeq = cursorEvent.seq;
	}
}

if (requiresFullRefresh) {
	const latestVisibleEvent = await db.query.syncEvent.findFirst({
		where: visibleEventsWhere,
		orderBy: [desc(syncEvent.seq)],
		columns: { id: true },
	});

	return {
		events: [],
		cursor: latestVisibleEvent ? { id: latestVisibleEvent.id } : null,
		hasMore: false,
		requiresFullRefresh: true,
	};
}
```

**Improved version**

```ts
let sinceSeq = 0;

if (input.sinceId) {
	const cursorEvent = await db.query.syncEvent.findFirst({
		where: and(eq(syncEvent.id, input.sinceId), visibleEventsWhere),
		columns: {
			id: true,
			seq: true,
		},
	});

	if (!cursorEvent) {
		const latestVisibleEvent = await db.query.syncEvent.findFirst({
			where: visibleEventsWhere,
			orderBy: [desc(syncEvent.seq)],
			columns: { id: true },
		});

		return {
			events: [],
			cursor: latestVisibleEvent ? { id: latestVisibleEvent.id } : null,
			hasMore: false,
			requiresFullRefresh: true,
		};
	}

	sinceSeq = cursorEvent.seq;
}
```

A second cleanup in the same block is to extract the repeated event mapping:

```ts
function toSyncEventDto(event: typeof events[number]) {
	return {
		id: event.id,
		type: event.eventType,
		entityId: event.entityId,
		entityType: event.entityType,
		vaultId: event.vaultId,
		version: event.version,
		clientId: event.clientId,
		userId: event.userId,
		metadata: event.metadata ? JSON.parse(event.metadata) : null,
		timestamp: event.createdAt.getTime(),
	};
}
```

## 5. Extract public share-link validation into one helper

**File path**

- `packages/api/src/routers/share.ts`

**Why**

`getPublicInfo`, `requestEmailVerification`, `verifyEmailAndAccess`, and `accessPublic` all perform slightly different copies of the same share-link validity rules. That duplication makes the public-link behavior hard to audit and easy to drift.

**Current code**

```ts
if (!(await hasShareLinksEntitlement(link.createdById))) {
	return {
		valid: false,
		reason: "disabled",
		accessMode: link.accessMode,
	};
}

const now = new Date();
if (link.status === "revoked") {
	return {
		valid: false,
		reason: "revoked",
		accessMode: link.accessMode,
	};
}

if (link.expiresAt < now) {
	return {
		valid: false,
		reason: "expired",
		accessMode: link.accessMode,
	};
}

if (link.maxAccessCount && link.accessCount >= link.maxAccessCount) {
	return {
		valid: false,
		reason: "exhausted",
		accessMode: link.accessMode,
	};
}
```

```ts
const now = new Date();
if (
	link.status !== "active" ||
	link.expiresAt < now ||
	(link.maxAccessCount && link.accessCount >= link.maxAccessCount)
) {
	throw new TRPCError({
		code: "BAD_REQUEST",
		message: "This share link is no longer valid",
	});
}
```

**Improved version**

```ts
type PublicShareState =
	| { valid: true }
	| { valid: false; reason: "disabled" | "revoked" | "expired" | "exhausted" };

async function getPublicShareState(link: {
	createdById: string;
	status: string;
	expiresAt: Date;
	maxAccessCount: number | null;
	accessCount: number;
}): Promise<PublicShareState> {
	if (!(await hasShareLinksEntitlement(link.createdById))) {
		return { valid: false, reason: "disabled" };
	}

	if (link.status === "revoked") {
		return { valid: false, reason: "revoked" };
	}

	if (link.expiresAt < new Date()) {
		return { valid: false, reason: "expired" };
	}

	if (link.maxAccessCount && link.accessCount >= link.maxAccessCount) {
		return { valid: false, reason: "exhausted" };
	}

	return { valid: true };
}
```

```ts
const state = await getPublicShareState(link);

if (!state.valid) {
	return {
		valid: false,
		reason: state.reason,
		accessMode: link.accessMode,
	};
}
```

```ts
const state = await getPublicShareState(link);
if (!state.valid) {
	throw new TRPCError({
		code: "BAD_REQUEST",
		message: "This share link is no longer valid",
	});
}
```

## 6. Extract the duplicated share-link access update query

**File path**

- `packages/api/src/routers/share.ts`

**Why**

`verifyEmailAndAccess` and `accessPublic` both inline the same access-count update, status transition, and “no rows updated” handling. This is a good candidate for a focused helper.

**Current code**

```ts
const accessUpdate = await db
	.update(shareLink)
	.set({
		accessCount: sql`${shareLink.accessCount} + 1`,
		lastAccessedAt: now,
		status: sql`CASE
			WHEN ${shareLink.maxAccessCount} IS NOT NULL
				AND ${shareLink.accessCount} + 1 >= ${shareLink.maxAccessCount}
			THEN 'exhausted'::share_link_status
			ELSE ${shareLink.status}
		END`,
	})
	.where(
		and(
			eq(shareLink.id, link.id),
			eq(shareLink.status, "active"),
			gt(shareLink.expiresAt, now),
			or(
				isNull(shareLink.maxAccessCount),
				sql`${shareLink.accessCount} < ${shareLink.maxAccessCount}`,
			),
		),
	)
	.returning({ id: shareLink.id });

if (accessUpdate.length === 0) {
	throw new TRPCError({
		code: "BAD_REQUEST",
		message: "This share link has reached its access limit",
	});
}
```

**Improved version**

```ts
async function consumeShareLinkAccess(
	shareLinkId: string,
	now: Date,
): Promise<boolean> {
	const updated = await db
		.update(shareLink)
		.set({
			accessCount: sql`${shareLink.accessCount} + 1`,
			lastAccessedAt: now,
			status: sql`CASE
				WHEN ${shareLink.maxAccessCount} IS NOT NULL
					AND ${shareLink.accessCount} + 1 >= ${shareLink.maxAccessCount}
				THEN 'exhausted'::share_link_status
				ELSE ${shareLink.status}
			END`,
		})
		.where(
			and(
				eq(shareLink.id, shareLinkId),
				eq(shareLink.status, "active"),
				gt(shareLink.expiresAt, now),
				or(
					isNull(shareLink.maxAccessCount),
					sql`${shareLink.accessCount} < ${shareLink.maxAccessCount}`,
				),
			),
		)
		.returning({ id: shareLink.id });

	return updated.length > 0;
}
```

```ts
if (!(await consumeShareLinkAccess(link.id, now))) {
	throw new TRPCError({
		code: "BAD_REQUEST",
		message: "This share link has reached its access limit",
	});
}
```

## 7. Pull the audit query builders and mappers into small functions

**File path**

- `packages/api/src/routers/audit.ts`

**Why**

`teamEvents` is doing authorization, input validation, condition building for two data sources, two queries, and row-to-DTO mapping in a single procedure. The behavior is correct, but the function is too broad and repetitive.

**Current code**

```ts
const auditConditions = [inArray(auditLog.userId, memberIds)];
if (input.actorUserId) {
	auditConditions.push(eq(auditLog.userId, input.actorUserId));
}
if (fromDate) {
	auditConditions.push(gte(auditLog.createdAt, fromDate));
}
if (toDate) {
	auditConditions.push(lte(auditLog.createdAt, toDate));
}
const auditCursorCondition = buildCursorCondition(
	cursor,
	"audit_log",
	auditLog.createdAt,
	auditLog.id,
);
if (auditCursorCondition) {
	auditConditions.push(auditCursorCondition);
}
const auditActionGroupCondition = buildAuditActionGroupCondition(
	input.actionGroup,
);
if (auditActionGroupCondition) {
	auditConditions.push(auditActionGroupCondition);
}
if (searchPattern) {
	const auditSearchCondition = or(
		ilike(auditLog.action, searchPattern),
		ilike(auditLog.entityType, searchPattern),
		ilike(auditLog.entityId, searchPattern),
		ilike(auditLog.userId, searchPattern),
		ilike(auditLog.metadata, searchPattern),
	);
	if (auditSearchCondition) {
		auditConditions.push(auditSearchCondition);
	}
}
```

```ts
for (const row of auditRows) {
	const eventActor = memberMap.get(row.userId);
	events.push({
		id: row.id,
		timestamp: row.createdAt.toISOString(),
		source: "audit_log",
		action: row.action,
		actionGroup: getActionGroup(row.action),
		actor: {
			userId: row.userId,
			name: eventActor?.name ?? null,
			email: eventActor?.email ?? null,
		},
		entity: {
			type: row.entityType,
			id: row.entityId,
		},
		result: "success",
		network: {
			maskedIp: maskIp(row.ipAddress),
			maskedUserAgent: maskUserAgent(row.userAgent),
			fullIp: row.ipAddress,
			fullUserAgent: row.userAgent,
		},
		metadata: parseMetadata(row.metadata),
	});
}
```

**Improved version**

```ts
function pushIf<T>(items: T[], value: T | undefined | null): void {
	if (value) items.push(value);
}

function buildAuditConditions(args: {
	memberIds: string[];
	actorUserId?: string;
	fromDate: Date | null;
	toDate: Date | null;
	cursor: EventCursorPayload | null;
	actionGroup: QueryActionGroup;
	searchPattern: string | null;
}) {
	const conditions = [inArray(auditLog.userId, args.memberIds)];

	pushIf(
		conditions,
		args.actorUserId ? eq(auditLog.userId, args.actorUserId) : undefined,
	);
	pushIf(
		conditions,
		args.fromDate ? gte(auditLog.createdAt, args.fromDate) : undefined,
	);
	pushIf(
		conditions,
		args.toDate ? lte(auditLog.createdAt, args.toDate) : undefined,
	);
	pushIf(
		conditions,
		buildCursorCondition(args.cursor, "audit_log", auditLog.createdAt, auditLog.id),
	);
	pushIf(conditions, buildAuditActionGroupCondition(args.actionGroup));
	pushIf(
		conditions,
		args.searchPattern
			? or(
					ilike(auditLog.action, args.searchPattern),
					ilike(auditLog.entityType, args.searchPattern),
					ilike(auditLog.entityId, args.searchPattern),
					ilike(auditLog.userId, args.searchPattern),
					ilike(auditLog.metadata, args.searchPattern),
				)
			: undefined,
	);

	return conditions;
}

function toAuditEvent(
	row: typeof auditRows[number],
	memberMap: Map<string, { name: string | null; email: string | null }>,
): TeamEvent {
	const actor = memberMap.get(row.userId);

	return {
		id: row.id,
		timestamp: row.createdAt.toISOString(),
		source: "audit_log",
		action: row.action,
		actionGroup: getActionGroup(row.action),
		actor: {
			userId: row.userId,
			name: actor?.name ?? null,
			email: actor?.email ?? null,
		},
		entity: {
			type: row.entityType,
			id: row.entityId,
		},
		result: "success",
		network: {
			maskedIp: maskIp(row.ipAddress),
			maskedUserAgent: maskUserAgent(row.userAgent),
			fullIp: row.ipAddress,
			fullUserAgent: row.userAgent,
		},
		metadata: parseMetadata(row.metadata),
	};
}
```

## 8. Replace the long UA detection chains with table-driven detectors

**File path**

- `packages/api/src/utils/device.ts`

**Why**

The OS, browser, platform, and device-name logic is correct but very long and branch-heavy. A detector table would keep the ordering explicit while making the function much shorter and easier to extend.

**Current code**

```ts
if (ua.includes("windows")) {
	osName = "Windows";
	const match = userAgent.match(/Windows NT (\d+\.?\d*)/i);
	if (match?.[1]) {
		const ntVersion = match[1];
		const versionMap: Record<string, string> = {
			"10.0": "10/11",
			"6.3": "8.1",
			"6.2": "8",
			"6.1": "7",
			"6.0": "Vista",
			"5.1": "XP",
		};
		osVersion = versionMap[ntVersion] ?? ntVersion;
	}
} else if (ua.includes("mac os x") || ua.includes("macos")) {
	osName = "macOS";
	const match = userAgent.match(/Mac OS X (\d+[._]\d+(?:[._]\d+)?)/i);
	if (match?.[1]) {
		osVersion = match[1].replace(/_/g, ".");
	}
} else if (ua.includes("iphone") || ua.includes("ipad")) {
	osName = ua.includes("ipad") ? "iPadOS" : "iOS";
	const match = userAgent.match(/OS (\d+[._]\d+(?:[._]\d+)?)/i);
	if (match?.[1]) {
		osVersion = match[1].replace(/_/g, ".");
	}
}
```

```ts
if (ua.includes("edg/")) {
	browserName = "Edge";
	const match = userAgent.match(/Edg\/(\d+\.?\d*\.?\d*)/i);
	if (match?.[1]) browserVersion = match[1];
} else if (ua.includes("opr/") || ua.includes("opera")) {
	browserName = "Opera";
	const match = userAgent.match(/(?:OPR|Opera)\/(\d+\.?\d*\.?\d*)/i);
	if (match?.[1]) browserVersion = match[1];
} else if (ua.includes("brave")) {
	browserName = "Brave";
	const match = userAgent.match(/Brave\/(\d+\.?\d*\.?\d*)/i);
	if (match?.[1]) browserVersion = match[1];
}
```

**Improved version**

```ts
type Detector<T> = {
	matches: (ua: string) => boolean;
	parse: (userAgent: string, ua: string) => T;
};

const OS_DETECTORS: Detector<Pick<DeviceInfo, "osName" | "osVersion">>[] = [
	{
		matches: (ua) => ua.includes("windows"),
		parse: (userAgent) => {
			const version = userAgent.match(/Windows NT (\d+\.?\d*)/i)?.[1] ?? null;
			const versionMap: Record<string, string> = {
				"10.0": "10/11",
				"6.3": "8.1",
				"6.2": "8",
				"6.1": "7",
				"6.0": "Vista",
				"5.1": "XP",
			};

			return {
				osName: "Windows",
				osVersion: version ? versionMap[version] ?? version : null,
			};
		},
	},
	{
		matches: (ua) => ua.includes("mac os x") || ua.includes("macos"),
		parse: (userAgent) => ({
			osName: "macOS",
			osVersion:
				userAgent.match(/Mac OS X (\d+[._]\d+(?:[._]\d+)?)/i)?.[1]?.replace(
					/_/g,
					".",
				) ?? null,
		}),
	},
];

function detectFirst<T>(
	detectors: Detector<T>[],
	ua: string,
	userAgent: string,
	fallback: T,
): T {
	return detectors.find((detector) => detector.matches(ua))?.parse(userAgent, ua) ?? fallback;
}
```

## 9. Remove duplicate recipient collection and payload shaping from SSE delivery

**File path**

- `apps/server/src/sync/sse-handler.ts`

**Why**

`deliverToConnections` repeats the same “collect recipients for a vault” logic for `vault_created` and `vault_deleted`, and it also repeats the payload shape that adds `isOwnEvent` and `originClientId`.

**Current code**

```ts
const vaultCreatedRecipients =
	event.type === "vault_created" && vaultId
		? (() => {
				const recipients = new Set<string>([eventUserId]);
				for (const [userId] of connections) {
					if (userVaults.get(userId)?.has(vaultId)) {
						recipients.add(userId);
					}
				}
				return recipients;
			})()
		: null;
const vaultDeletedRecipients =
	event.type === "vault_deleted" && vaultId
		? (() => {
				const recipients = new Set<string>([eventUserId]);
				for (const [userId] of connections) {
					if (userVaults.get(userId)?.has(vaultId)) {
						recipients.add(userId);
					}
				}
				return recipients;
			})()
		: null;
```

```ts
connection.channel.push({
	...event,
	metadata: {
		...event.metadata,
		isOwnEvent: userId === eventUserId,
		originClientId: clientId,
	},
});
```

**Improved version**

```ts
function collectVaultRecipients(
	vaultId: string,
	actorUserId: string,
): Set<string> {
	const recipients = new Set<string>([actorUserId]);

	for (const [userId] of connections) {
		if (userVaults.get(userId)?.has(vaultId)) {
			recipients.add(userId);
		}
	}

	return recipients;
}

function createOutboundSyncPayload(
	event: SyncEventPayload,
	recipientUserId: string,
): StreamPayload {
	return {
		...event,
		metadata: {
			...event.metadata,
			isOwnEvent: recipientUserId === event.userId,
			originClientId: event.clientId,
		},
	};
}
```

```ts
const vaultCreatedRecipients =
	event.type === "vault_created" && vaultId
		? collectVaultRecipients(vaultId, eventUserId)
		: null;

const vaultDeletedRecipients =
	event.type === "vault_deleted" && vaultId
		? collectVaultRecipients(vaultId, eventUserId)
		: null;

connection.channel.push(createOutboundSyncPayload(event, userId));
```
