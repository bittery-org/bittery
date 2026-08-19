import assert from "node:assert/strict";
import test from "node:test";
import {
	formatStorageBytes,
	formatUsagePercentage,
	getAttachmentUsageSnapshot,
} from "./billing-attachment-usage";

test("returns available state with rounded percentage and clamped progress", () => {
	assert.deepEqual(
		getAttachmentUsageSnapshot({
			attachmentsEnabled: true,
			committedStorageBytes: 150,
			quotaBytes: 100,
		}),
		{
			state: "available",
			committedStorageBytes: 150,
			quotaBytes: 100,
			usedPercentage: 150,
			progressPercentage: 100,
		},
	);
});

test("returns unavailable state when attachments are disabled", () => {
	assert.deepEqual(
		getAttachmentUsageSnapshot({
			attachmentsEnabled: false,
			committedStorageBytes: 64,
			quotaBytes: 0,
		}),
		{
			state: "unavailable",
			committedStorageBytes: 64,
			quotaBytes: 0,
			usedPercentage: null,
			progressPercentage: null,
		},
	);
});

test("formats storage bytes with localized units", () => {
	assert.equal(formatStorageBytes(250 * 1024 * 1024, "en-US"), "250 MB");
	assert.equal(formatStorageBytes(1536, "en-US"), "1.5 kB");
});

test("formats usage percentages for display", () => {
	assert.equal(formatUsagePercentage(73, "en-US"), "73%");
});
