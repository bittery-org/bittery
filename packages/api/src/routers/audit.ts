import { db } from "@bittery/db";
import { auditLog } from "@bittery/db/schema/auth";
import { shareAccessLog, shareLink } from "@bittery/db/schema/sharing";
import { TRPCError } from "@trpc/server";
import {
	and,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	lt,
	lte,
	or,
} from "drizzle-orm";
import { z } from "zod";
import { resolveEffectiveEntitlements } from "../billing/entitlements";
import { getBitteryMode } from "../config/mode";
import { protectedProcedure, router } from "../index";

type EventSource = "audit_log" | "share_access_log";
type ActionGroup = "auth" | "team" | "vault" | "item" | "share" | "other";
type QueryActionGroup = ActionGroup | "all";

export interface TeamEvent {
	id: string;
	timestamp: string;
	source: EventSource;
	action: string;
	actionGroup: ActionGroup;
	actor: {
		userId: string | null;
		name: string | null;
		email: string | null;
	};
	entity: {
		type: string | null;
		id: string | null;
	};
	result: "success" | "failure";
	network: {
		maskedIp: string | null;
		maskedUserAgent: string | null;
		fullIp: string | null;
		fullUserAgent: string | null;
	};
	metadata: Record<string, unknown> | null;
}

interface EventCursorPayload {
	timestamp: string;
	source: EventSource;
	id: string;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const authActionSet = new Set([
	"password_reset_via_recovery",
	"logout_all",
	"email_changed",
	"password_changed",
	"secret_key_regenerated",
	"device_revoked",
	"account_deleted",
]);

function getActionGroup(action: string): ActionGroup {
	if (action.startsWith("team_")) return "team";
	if (action.startsWith("vault_")) return "vault";
	if (action.startsWith("item_")) return "item";
	if (action.startsWith("share_")) return "share";
	if (authActionSet.has(action)) return "auth";
	return "other";
}

function getSourceRank(source: EventSource): number {
	return source === "audit_log" ? 1 : 0;
}

function compareEventOrder(a: TeamEvent, b: TeamEvent): number {
	const timestampDiff =
		new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
	if (timestampDiff !== 0) return timestampDiff;

	const sourceRankDiff = getSourceRank(b.source) - getSourceRank(a.source);
	if (sourceRankDiff !== 0) return sourceRankDiff;

	return b.id.localeCompare(a.id);
}

function encodeCursor(cursor: EventCursorPayload): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): EventCursorPayload {
	try {
		const parsed = JSON.parse(
			Buffer.from(raw, "base64url").toString("utf8"),
		) as EventCursorPayload;
		if (
			!parsed ||
			typeof parsed !== "object" ||
			typeof parsed.timestamp !== "string" ||
			typeof parsed.source !== "string" ||
			typeof parsed.id !== "string" ||
			(parsed.source !== "audit_log" && parsed.source !== "share_access_log")
		) {
			throw new Error("Malformed cursor");
		}
		return parsed;
	} catch {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid pagination cursor",
		});
	}
}

function parseMetadata(metadata: string | null): Record<string, unknown> | null {
	if (!metadata) return null;
	try {
		const parsed = JSON.parse(metadata);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

function maskIp(ipAddress: string | null): string | null {
	if (!ipAddress) return null;

	if (ipAddress.includes(".")) {
		const segments = ipAddress.split(".");
		if (segments.length === 4) {
			return `${segments[0]}.${segments[1]}.x.x`;
		}
	}

	if (ipAddress.includes(":")) {
		const segments = ipAddress.split(":").filter(Boolean);
		if (segments.length >= 2) {
			return `${segments.slice(0, 2).join(":")}:xxxx:xxxx::*`;
		}
	}

	return "masked";
}

function maskUserAgent(userAgent: string | null): string | null {
	if (!userAgent) return null;
	if (userAgent.includes("Chrome")) return "Chrome";
	if (userAgent.includes("Firefox")) return "Firefox";
	if (userAgent.includes("Safari") && !userAgent.includes("Chrome")) {
		return "Safari";
	}
	if (userAgent.includes("Edge")) return "Edge";
	return userAgent.split(" ")[0] || "Unknown";
}

function buildAuditActionGroupCondition(actionGroup: QueryActionGroup) {
	if (actionGroup === "all" || actionGroup === "other") return undefined;
	if (actionGroup === "team") return ilike(auditLog.action, "team_%");
	if (actionGroup === "vault") return ilike(auditLog.action, "vault_%");
	if (actionGroup === "item") return ilike(auditLog.action, "item_%");
	if (actionGroup === "share") return ilike(auditLog.action, "share_%");
	if (actionGroup === "auth") {
		const filters = Array.from(authActionSet).map((action) =>
			eq(auditLog.action, action),
		);
		return filters.length === 1 ? filters[0] : or(...filters);
	}
	return undefined;
}

function buildCursorCondition(
	cursor: EventCursorPayload | null,
	source: EventSource,
	timestampColumn: any,
	idColumn: any,
) {
	if (!cursor) return undefined;

	const cursorTimestamp = new Date(cursor.timestamp);
	if (Number.isNaN(cursorTimestamp.getTime())) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid pagination cursor",
		});
	}

	const sourceRank = getSourceRank(source);
	const cursorRank = getSourceRank(cursor.source);

	// Ordering is DESC by timestamp, source rank, id.
	if (sourceRank > cursorRank) {
		return lt(timestampColumn, cursorTimestamp);
	}

	if (sourceRank < cursorRank) {
		return or(lt(timestampColumn, cursorTimestamp), eq(timestampColumn, cursorTimestamp));
	}

	return or(
		lt(timestampColumn, cursorTimestamp),
		and(eq(timestampColumn, cursorTimestamp), lt(idColumn, cursor.id)),
	);
}

export const auditRouter = router({
	teamEvents: protectedProcedure
		.input(
			z.object({
				cursor: z.string().optional(),
				limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
				from: z.string().datetime().optional(),
				to: z.string().datetime().optional(),
				actionGroup: z
					.enum(["auth", "team", "vault", "item", "share", "other", "all"])
					.default("all"),
				actorUserId: z.string().optional(),
				result: z.enum(["success", "failure", "all"]).default("all"),
				search: z.string().trim().max(100).optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const actor = await db.query.user.findFirst({
				where: (u, { eq }) => eq(u.id, ctx.session.userId),
				with: { team: true },
			});

			if (!actor || !actor.team || !actor.teamId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Team not found",
				});
			}
			const teamId = actor.teamId;

			if (!["owner", "admin"].includes(actor.role)) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Only team owner or admin can access this console",
				});
			}

			if (actor.team.billingPlan !== "team") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "This console is only available on Team plans",
				});
			}

			const entitlements = resolveEffectiveEntitlements({
				mode: getBitteryMode(),
				billingPlan: actor.team.billingPlan,
				billingStatus: actor.team.billingStatus,
			});

			if (!entitlements.team_management) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Team management is unavailable until billing is active",
				});
			}

			const members = await db.query.user.findMany({
				where: (u, { eq }) => eq(u.teamId, teamId),
				columns: {
					id: true,
					name: true,
					email: true,
				},
			});

			const memberMap = new Map(members.map((member) => [member.id, member]));
			const memberIds = members.map((member) => member.id);

			if (memberIds.length === 0) {
				return { events: [] as TeamEvent[], nextCursor: null as string | null };
			}

			if (input.actorUserId && !memberMap.has(input.actorUserId)) {
				return { events: [] as TeamEvent[], nextCursor: null as string | null };
			}

			const fromDate = input.from ? new Date(input.from) : null;
			const toDate = input.to ? new Date(input.to) : null;
			if (fromDate && Number.isNaN(fromDate.getTime())) {
				throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid from date" });
			}
			if (toDate && Number.isNaN(toDate.getTime())) {
				throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid to date" });
			}
			if (fromDate && toDate && fromDate > toDate) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The from date must be before the to date",
				});
			}

			const cursor = input.cursor ? decodeCursor(input.cursor) : null;
			const searchPattern = input.search ? `%${input.search}%` : null;
			const fetchLimit = Math.min(input.limit, MAX_LIMIT) + 1;

			const includeAudit =
				input.actionGroup !== "share" && input.result !== "failure";
			const includeShare =
				input.actionGroup === "all" || input.actionGroup === "share";

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

			const shareConditions = [inArray(shareLink.createdById, memberIds)];
			if (input.actorUserId) {
				shareConditions.push(eq(shareLink.createdById, input.actorUserId));
			}
			if (fromDate) {
				shareConditions.push(gte(shareAccessLog.accessedAt, fromDate));
			}
			if (toDate) {
				shareConditions.push(lte(shareAccessLog.accessedAt, toDate));
			}
			if (input.result === "success") {
				shareConditions.push(eq(shareAccessLog.success, true));
			}
			if (input.result === "failure") {
				shareConditions.push(eq(shareAccessLog.success, false));
			}
			const shareCursorCondition = buildCursorCondition(
				cursor,
				"share_access_log",
				shareAccessLog.accessedAt,
				shareAccessLog.id,
			);
			if (shareCursorCondition) {
				shareConditions.push(shareCursorCondition);
			}
			if (searchPattern) {
				const shareSearchCondition = or(
					ilike(shareAccessLog.shareLinkId, searchPattern),
					ilike(shareAccessLog.accessedByEmail, searchPattern),
					ilike(shareAccessLog.failureReason, searchPattern),
				);
				if (shareSearchCondition) {
					shareConditions.push(shareSearchCondition);
				}
			}

			const [auditRows, shareRows] = await Promise.all([
				includeAudit
					? db
							.select({
								id: auditLog.id,
								userId: auditLog.userId,
								action: auditLog.action,
								entityType: auditLog.entityType,
								entityId: auditLog.entityId,
								ipAddress: auditLog.ipAddress,
								userAgent: auditLog.userAgent,
								metadata: auditLog.metadata,
								createdAt: auditLog.createdAt,
							})
							.from(auditLog)
							.where(and(...auditConditions))
							.orderBy(desc(auditLog.createdAt), desc(auditLog.id))
							.limit(fetchLimit)
					: Promise.resolve([]),
				includeShare
					? db
							.select({
								id: shareAccessLog.id,
								shareLinkId: shareAccessLog.shareLinkId,
								createdById: shareLink.createdById,
								accessedByEmail: shareAccessLog.accessedByEmail,
								ipAddress: shareAccessLog.ipAddress,
								userAgent: shareAccessLog.userAgent,
								success: shareAccessLog.success,
								failureReason: shareAccessLog.failureReason,
								accessedAt: shareAccessLog.accessedAt,
							})
							.from(shareAccessLog)
							.innerJoin(shareLink, eq(shareAccessLog.shareLinkId, shareLink.id))
							.where(and(...shareConditions))
							.orderBy(desc(shareAccessLog.accessedAt), desc(shareAccessLog.id))
							.limit(fetchLimit)
					: Promise.resolve([]),
			]);

			const events: TeamEvent[] = [];

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

			for (const row of shareRows) {
				const createdBy = memberMap.get(row.createdById);
				events.push({
					id: row.id,
					timestamp: row.accessedAt.toISOString(),
					source: "share_access_log",
					action: row.success ? "share_access_success" : "share_access_failed",
					actionGroup: "share",
					actor: {
						userId: null,
						name: row.accessedByEmail,
						email: row.accessedByEmail,
					},
					entity: {
						type: "share_link",
						id: row.shareLinkId,
					},
					result: row.success ? "success" : "failure",
					network: {
						maskedIp: maskIp(row.ipAddress),
						maskedUserAgent: maskUserAgent(row.userAgent),
						fullIp: row.ipAddress,
						fullUserAgent: row.userAgent,
					},
					metadata: {
						failureReason: row.failureReason,
						createdByUserId: row.createdById,
						createdByName: createdBy?.name ?? null,
						createdByEmail: createdBy?.email ?? null,
					},
				});
			}

			const groupedEvents =
				input.actionGroup === "other"
					? events.filter((event) => event.actionGroup === "other")
					: events;

			groupedEvents.sort(compareEventOrder);
			const pageEvents = groupedEvents.slice(0, input.limit);
			const hasMore = groupedEvents.length > input.limit;
			const cursorBoundary = hasMore ? pageEvents[pageEvents.length - 1] : null;

			const nextCursor = cursorBoundary
				? encodeCursor({
						timestamp: cursorBoundary.timestamp,
						source: cursorBoundary.source,
						id: cursorBoundary.id,
					})
				: null;

			return {
				events: pageEvents,
				nextCursor,
			};
		}),
});
