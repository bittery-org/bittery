import { db } from "@bittery/db";
import { auditLog } from "@bittery/db/schema/auth";
import { nanoid } from "nanoid";
import type { DeviceContext } from "../context";

interface LogAuditInput {
	userId: string;
	action: string;
	device: DeviceContext;
	entityType?: string;
	entityId?: string;
	metadata?: Record<string, unknown>;
}

export async function logAuditEvent({
	userId,
	action,
	device,
	entityType,
	entityId,
	metadata,
}: LogAuditInput): Promise<void> {
	await db.insert(auditLog).values({
		id: nanoid(),
		userId,
		action,
		entityType: entityType ?? null,
		entityId: entityId ?? null,
		ipAddress: device.ipAddress,
		userAgent: device.userAgent,
		metadata: metadata ? JSON.stringify(metadata) : null,
	});
}
