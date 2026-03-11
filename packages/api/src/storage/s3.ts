import { createHmac, randomUUID } from "node:crypto";
import {
	HeadObjectCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isPublicStorageKeyAllowed } from "./public-access";

export interface StorageConfig {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export interface PresignedUploadResult {
	key: string;
	uploadUrl: string;
	publicUrl: string | null;
}

export interface StorageObjectHead {
	size: number;
	contentType: string | null;
}

let client: S3Client | null = null;
const ATTACHMENT_UPLOAD_KEY_TTL_MS = 15 * 60 * 1000;
const ATTACHMENT_UPLOAD_KEY_PATTERN =
	/^attachments\/([^/]+)\/([^/]+)\/(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([A-Za-z0-9_-]{43})-([A-Za-z0-9._-]{1,120})$/i;

function getStorageConfig(): StorageConfig {
	const endpoint = process.env.BITTERY_STORAGE_ENDPOINT;
	const bucket = process.env.BITTERY_STORAGE_BUCKET;
	const accessKeyId = process.env.BITTERY_STORAGE_ACCESS_KEY_ID;
	const secretAccessKey = process.env.BITTERY_STORAGE_SECRET_ACCESS_KEY;
	const region = process.env.BITTERY_STORAGE_REGION || "auto";

	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
		throw new Error(
			"Missing storage config. Set BITTERY_STORAGE_ENDPOINT, BITTERY_STORAGE_BUCKET, BITTERY_STORAGE_ACCESS_KEY_ID, and BITTERY_STORAGE_SECRET_ACCESS_KEY.",
		);
	}

	return {
		endpoint,
		region,
		bucket,
		accessKeyId,
		secretAccessKey,
	};
}

export function getStorageClient(): S3Client {
	if (!client) {
		const config = getStorageConfig();
		client = new S3Client({
			region: config.region,
			endpoint: config.endpoint,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
		});
	}

	return client;
}

export function getStoragePublicUrl(key: string): string | null {
	if (!isPublicStorageKeyAllowed(key)) {
		return null;
	}

	const baseUrl =
		process.env.BITTERY_STORAGE_CDN_URL ||
		process.env.BITTERY_STORAGE_PUBLIC_URL;
	if (!baseUrl) return null;

	const normalizedBase = baseUrl.replace(/\/+$/, "");
	return `${normalizedBase}/${key}`;
}

function sanitizeFileName(fileName: string): string {
	const trimmed = fileName.trim();
	const base = trimmed.length > 0 ? trimmed : "image";
	const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
	return safe.slice(0, 120) || "image";
}

function getAttachmentUploadSigningSecret(): string {
	const secret =
		process.env.BITTERY_ATTACHMENT_UPLOAD_SECRET || process.env.JWT_SECRET;
	if (!secret) {
		throw new Error(
			"Missing attachment upload signing secret. Set BITTERY_ATTACHMENT_UPLOAD_SECRET or JWT_SECRET.",
		);
	}
	return secret;
}

function signAttachmentUploadIntent(payload: string): string {
	return createHmac("sha256", getAttachmentUploadSigningSecret())
		.update(payload)
		.digest("base64url");
}

export function createVaultImageKey(params: {
	userId: string;
	vaultId?: string;
	fileName: string;
}): string {
	const safeName = sanitizeFileName(params.fileName);
	const vaultSegment = params.vaultId ?? "draft";
	return `vaults/${params.userId}/${vaultSegment}/${randomUUID()}-${safeName}`;
}

export function createAttachmentKey(params: {
	userId: string;
	itemId: string;
	fileName: string;
}): string {
	const safeName = sanitizeFileName(params.fileName);
	const uploadId = randomUUID();
	const expiresAtMs = Date.now() + ATTACHMENT_UPLOAD_KEY_TTL_MS;
	const signature = signAttachmentUploadIntent(
		`${params.userId}:${params.itemId}:${uploadId}:${expiresAtMs}`,
	);

	return `attachments/${params.userId}/${params.itemId}/${expiresAtMs}-${uploadId}-${signature}-${safeName}`;
}

export function isValidAttachmentUploadKey(params: {
	key: string;
	userId: string;
	itemId: string;
	now?: Date;
}): boolean {
	const match = ATTACHMENT_UPLOAD_KEY_PATTERN.exec(params.key);
	if (!match) {
		return false;
	}

	const [, keyUserId, keyItemId, expiresAtRaw, uploadId, signature] = match;
	if (keyUserId !== params.userId || keyItemId !== params.itemId) {
		return false;
	}

	const expiresAtMs = Number(expiresAtRaw);
	if (!Number.isFinite(expiresAtMs)) {
		return false;
	}
	if (expiresAtMs < (params.now?.getTime() ?? Date.now())) {
		return false;
	}

	const expectedSignature = signAttachmentUploadIntent(
		`${keyUserId}:${keyItemId}:${uploadId}:${expiresAtMs}`,
	);
	return signature === expectedSignature;
}

export function createTeamImageKey(params: {
	teamId: string;
	fileName: string;
}): string {
	const safeName = sanitizeFileName(params.fileName);
	return `teams/${params.teamId}/${randomUUID()}-${safeName}`;
}

export async function createPresignedUpload(params: {
	key: string;
	contentType: string;
	contentLength?: number;
	expiresInSeconds?: number;
}): Promise<PresignedUploadResult> {
	const config = getStorageConfig();
	const s3Client = getStorageClient();

	const command = new PutObjectCommand({
		Bucket: config.bucket,
		Key: params.key,
		ContentType: params.contentType,
		...(params.contentLength !== undefined
			? { ContentLength: params.contentLength }
			: {}),
	});

	const uploadUrl = await getSignedUrl(s3Client, command, {
		expiresIn: params.expiresInSeconds ?? 300,
	});

	return {
		key: params.key,
		uploadUrl,
		publicUrl: getStoragePublicUrl(params.key),
	};
}

export async function createPresignedDownload(params: {
	key: string;
	expiresInSeconds?: number;
}): Promise<string> {
	const config = getStorageConfig();
	const s3Client = getStorageClient();

	const command = new GetObjectCommand({
		Bucket: config.bucket,
		Key: params.key,
	});

	return getSignedUrl(s3Client, command, {
		expiresIn: params.expiresInSeconds ?? 300,
	});
}

export async function headObject(
	key: string,
): Promise<StorageObjectHead | null> {
	const config = getStorageConfig();
	const s3Client = getStorageClient();

	try {
		const result = await s3Client.send(
			new HeadObjectCommand({
				Bucket: config.bucket,
				Key: key,
			}),
		);

		return {
			size: result.ContentLength ?? 0,
			contentType: result.ContentType ?? null,
		};
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			("$metadata" in error || "name" in error)
		) {
			const maybeName =
				typeof (error as { name?: unknown }).name === "string"
					? (error as { name: string }).name
					: "";
			const maybeStatus =
				typeof (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata
					?.httpStatusCode === "number"
					? (error as { $metadata: { httpStatusCode: number } }).$metadata
							.httpStatusCode
					: null;
			if (
				maybeName === "NotFound" ||
				maybeName === "NoSuchKey" ||
				maybeStatus === 404
			) {
				return null;
			}
		}

		throw error;
	}
}

/**
 * Delete an object from S3 storage
 */
export async function deleteObject(key: string): Promise<void> {
	const config = getStorageConfig();
	const s3Client = getStorageClient();

	const command = new DeleteObjectCommand({
		Bucket: config.bucket,
		Key: key,
	});

	await s3Client.send(command);
}
