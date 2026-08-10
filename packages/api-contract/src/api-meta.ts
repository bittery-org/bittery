export interface ApiLimits {
	itemCiphertextBytes: string;
	bulkImportBytes: string;
	bulkImportItems: number;
}

export interface ApiVersionMetadata {
	supportedMajors: readonly number[];
	preferredMajor: number;
}

export interface ApiMeta {
	serverRelease: string;
	api: ApiVersionMetadata;
	capabilities: readonly string[];
	limits: ApiLimits;
}

export interface ApiVersionNegotiation {
	major: number;
	serverRelease: string;
	capabilities: ReadonlySet<string>;
	limits: ApiLimits;
}

export class ApiMetaValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApiMetaValidationError";
	}
}

export class ApiVersionMismatchError extends Error {
	readonly serverSupportedMajors: readonly number[];
	readonly clientSupportedMajors: readonly number[];

	constructor(
		serverSupportedMajors: readonly number[],
		clientSupportedMajors: readonly number[],
	) {
		super("The server and client do not support a common API major version.");
		this.name = "ApiVersionMismatchError";
		this.serverSupportedMajors = serverSupportedMajors;
		this.clientSupportedMajors = clientSupportedMajors;
	}
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ApiMetaValidationError(`${path} must be an object.`);
	}

	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ApiMetaValidationError(`${path} must be a non-empty string.`);
	}

	return value;
}

function positiveSafeInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new ApiMetaValidationError(
			`${path} must be a positive safe integer.`,
		);
	}

	return value as number;
}

function positiveDecimalString(value: unknown, path: string): string {
	if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
		throw new ApiMetaValidationError(
			`${path} must be a positive canonical decimal string.`,
		);
	}

	return value;
}

function uniquePositiveSafeIntegers(value: unknown, path: string): number[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new ApiMetaValidationError(`${path} must be a non-empty array.`);
	}

	const majors = value.map((major, index) =>
		positiveSafeInteger(major, `${path}/${index}`),
	);
	if (new Set(majors).size !== majors.length) {
		throw new ApiMetaValidationError(`${path} must not contain duplicates.`);
	}

	return majors;
}

function uniqueNonEmptyStrings(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) {
		throw new ApiMetaValidationError(`${path} must be an array.`);
	}

	const strings = value.map((entry, index) =>
		nonEmptyString(entry, `${path}/${index}`),
	);
	if (new Set(strings).size !== strings.length) {
		throw new ApiMetaValidationError(`${path} must not contain duplicates.`);
	}

	return strings;
}

/** Validates the discovery payload before it can influence login or sync policy. */
export function parseApiMeta(value: unknown): ApiMeta {
	const meta = object(value, "");
	const api = object(meta.api, "/api");
	const limits = object(meta.limits, "/limits");
	const supportedMajors = uniquePositiveSafeIntegers(
		api.supportedMajors,
		"/api/supportedMajors",
	);
	const preferredMajor = positiveSafeInteger(
		api.preferredMajor,
		"/api/preferredMajor",
	);

	if (!supportedMajors.includes(preferredMajor)) {
		throw new ApiMetaValidationError(
			"/api/preferredMajor must be included in /api/supportedMajors.",
		);
	}

	return {
		serverRelease: nonEmptyString(meta.serverRelease, "/serverRelease"),
		api: {
			supportedMajors,
			preferredMajor,
		},
		capabilities: uniqueNonEmptyStrings(meta.capabilities, "/capabilities"),
		limits: {
			itemCiphertextBytes: positiveDecimalString(
				limits.itemCiphertextBytes,
				"/limits/itemCiphertextBytes",
			),
			bulkImportBytes: positiveDecimalString(
				limits.bulkImportBytes,
				"/limits/bulkImportBytes",
			),
			bulkImportItems: positiveSafeInteger(
				limits.bulkImportItems,
				"/limits/bulkImportItems",
			),
		},
	};
}

export function negotiateApiVersion(
	meta: ApiMeta,
	clientSupportedMajors: readonly number[],
): ApiVersionNegotiation {
	const clientMajors = uniquePositiveSafeIntegers(
		clientSupportedMajors,
		"/clientSupportedMajors",
	);
	const mutuallySupported = meta.api.supportedMajors.filter((major) =>
		clientMajors.includes(major),
	);

	if (mutuallySupported.length === 0) {
		throw new ApiVersionMismatchError(meta.api.supportedMajors, clientMajors);
	}

	const major = mutuallySupported.includes(meta.api.preferredMajor)
		? meta.api.preferredMajor
		: Math.max(...mutuallySupported);

	return {
		major,
		serverRelease: meta.serverRelease,
		capabilities: new Set(meta.capabilities),
		limits: meta.limits,
	};
}
