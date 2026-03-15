export type AttachmentUsageState = "available" | "unavailable";

export interface AttachmentUsageSnapshotInput {
	attachmentsEnabled: boolean;
	committedStorageBytes: number;
	quotaBytes: number | null;
}

export interface AttachmentUsageSnapshot {
	state: AttachmentUsageState;
	committedStorageBytes: number;
	quotaBytes: number | null;
	usedPercentage: number | null;
	progressPercentage: number | null;
}

const storageUnits = [
	{ threshold: 1024 ** 3, unit: "gigabyte" },
	{ threshold: 1024 ** 2, unit: "megabyte" },
	{ threshold: 1024, unit: "kilobyte" },
] as const;

export function getAttachmentUsageSnapshot(
	input: AttachmentUsageSnapshotInput,
): AttachmentUsageSnapshot {
	if (!input.attachmentsEnabled || !input.quotaBytes) {
		return {
			state: "unavailable",
			committedStorageBytes: input.committedStorageBytes,
			quotaBytes: input.quotaBytes,
			usedPercentage: null,
			progressPercentage: null,
		};
	}

	const usedPercentage = Math.round(
		(input.committedStorageBytes / input.quotaBytes) * 100,
	);

	return {
		state: "available",
		committedStorageBytes: input.committedStorageBytes,
		quotaBytes: input.quotaBytes,
		usedPercentage,
		progressPercentage: Math.min(usedPercentage, 100),
	};
}

export function formatStorageBytes(bytes: number, locale: string): string {
	const selectedUnit = storageUnits.find(
		({ threshold }) => bytes >= threshold,
	) ?? {
		threshold: 1,
		unit: "byte",
	};
	const value = bytes / selectedUnit.threshold;
	const maximumFractionDigits = value >= 10 || Number.isInteger(value) ? 0 : 1;

	return new Intl.NumberFormat(locale, {
		style: "unit",
		unit: selectedUnit.unit,
		unitDisplay: "short",
		maximumFractionDigits,
	}).format(value);
}

export function formatUsagePercentage(
	percentage: number,
	locale: string,
): string {
	return new Intl.NumberFormat(locale, {
		style: "percent",
		maximumFractionDigits: 0,
	}).format(percentage / 100);
}
