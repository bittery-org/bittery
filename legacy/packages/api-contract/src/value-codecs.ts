export class ApiValueValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApiValueValidationError";
	}
}

/** Converts the decimal-string wire representation before application code performs arithmetic. */
export function parseDecimalString(value: unknown, path: string): bigint {
	if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
		throw new ApiValueValidationError(
			`${path} must be a canonical unsigned decimal string.`,
		);
	}
	return BigInt(value);
}

/** Converts a server timestamp only after rejecting malformed or non-UTC RFC3339 values. */
export function parseRfc3339Utc(value: unknown, path: string): Date {
	if (
		typeof value !== "string" ||
		!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z$/.test(value)
	) {
		throw new ApiValueValidationError(
			`${path} must be an RFC3339 UTC timestamp.`,
		);
	}
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		throw new ApiValueValidationError(
			`${path} must be an RFC3339 UTC timestamp.`,
		);
	}
	return new Date(timestamp);
}
