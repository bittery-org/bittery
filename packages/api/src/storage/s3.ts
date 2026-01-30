import { randomUUID } from "node:crypto";
import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

let client: S3Client | null = null;

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

export function createVaultImageKey(params: {
	userId: string;
	vaultId?: string;
	fileName: string;
}): string {
	const safeName = sanitizeFileName(params.fileName);
	const vaultSegment = params.vaultId ?? "draft";
	return `vaults/${params.userId}/${vaultSegment}/${randomUUID()}-${safeName}`;
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
	expiresInSeconds?: number;
}): Promise<PresignedUploadResult> {
	const config = getStorageConfig();
	const s3Client = getStorageClient();

	const command = new PutObjectCommand({
		Bucket: config.bucket,
		Key: params.key,
		ContentType: params.contentType,
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
