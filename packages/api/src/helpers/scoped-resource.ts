import { db } from "@bittery/db";
import { item, itemAttachment, vaultKey } from "@bittery/db/schema/vault";
import { and, eq } from "drizzle-orm";

export async function getScopedItemAccess(actorUserId: string, itemId: string) {
	const [result] = await db
		.select({
			item,
			role: vaultKey.role,
		})
		.from(item)
		.innerJoin(
			vaultKey,
			and(eq(vaultKey.vaultId, item.vaultId), eq(vaultKey.userId, actorUserId)),
		)
		.where(eq(item.id, itemId))
		.limit(1);

	return result ?? null;
}

export async function getScopedAttachmentAccess(
	actorUserId: string,
	attachmentId: string,
) {
	const [result] = await db
		.select({
			attachment: itemAttachment,
			role: vaultKey.role,
		})
		.from(itemAttachment)
		.innerJoin(
			vaultKey,
			and(
				eq(vaultKey.vaultId, itemAttachment.vaultId),
				eq(vaultKey.userId, actorUserId),
			),
		)
		.where(eq(itemAttachment.id, attachmentId))
		.limit(1);

	return result ?? null;
}

export async function loadVisibleShareLinkForActor(
	linkId: string,
	actorUserId: string,
) {
	const link = await db.query.shareLink.findFirst({
		where: (record, { eq: eqFn }) => eqFn(record.id, linkId),
		with: {
			item: true,
			allowedEmails: true,
		},
	});

	if (!link) {
		return null;
	}

	const actorVaultAccess = await db.query.vaultKey.findFirst({
		where: (record, { and: andFn, eq: eqFn }) =>
			andFn(
				eqFn(record.vaultId, link.item.vaultId),
				eqFn(record.userId, actorUserId),
			),
	});

	if (!actorVaultAccess) {
		return null;
	}

	const canView =
		actorVaultAccess.role === "owner" ||
		actorVaultAccess.role === "admin" ||
		link.createdById === actorUserId;

	return canView ? { link, actorVaultAccess } : null;
}
