/**
 * Reader for the dev mail outbox - the JSONL file the server appends one line
 * to for every emailed verification code (`apps/server/src/services/auth_email.rs`,
 * gated on `BITTERY_ENABLE_DEV_AUTH_STUBS` + `BITTERY_DEV_MAIL_OUTBOX`).
 *
 * Codes are never exposed over the network, so this file is the only way a spec
 * can complete signup, recovery or an email-restricted share link.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

const webAppDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** Matches `purpose` in the outbox line; mirrors `VerificationPurpose`. */
export type MailPurpose = "signup" | "recovery" | "share_email";

export interface MailOutboxEntry {
	purpose: MailPurpose;
	email: string;
	code: string;
	context: Record<string, unknown>;
	/** RFC3339 with nanosecond precision; `new Date()` parses it. */
	issuedAt: string;
}

/**
 * One outbox per API server, because each project resets its own database and
 * a shared file would let one project's codes satisfy the other's waits.
 */
export const MAIL_OUTBOX_PATHS = {
	cloud: path.join(webAppDir, "test-results", "mail-outbox.jsonl"),
	"self-hosted": path.join(
		webAppDir,
		"test-results",
		"mail-outbox-self-hosted.jsonl",
	),
} satisfies Record<string, string>;

export type MailOutboxProject = keyof typeof MAIL_OUTBOX_PATHS;

function currentProjectName(): string {
	try {
		return test.info().project.name;
	} catch {
		return "cloud";
	}
}

/** Absolute path of the outbox the given project's API server writes to. */
export function mailOutboxPath(projectName = currentProjectName()): string {
	const outboxPath = (MAIL_OUTBOX_PATHS as Record<string, string | undefined>)[
		projectName
	];
	if (!outboxPath) {
		throw new Error(
			`No mail outbox is configured for project "${projectName}". Known projects: ${Object.keys(MAIL_OUTBOX_PATHS).join(", ")}.`,
		);
	}
	return outboxPath;
}

/**
 * The `since` watermark to take *before* triggering the email.
 *
 * Backdated slightly: the server stamps `issuedAt` from its own clock, and a
 * code that lands a few milliseconds "before" the watermark would be invisible
 * forever. Addresses are unique per run, so a wider window cannot match an
 * older code for the same email.
 */
export function mailOutboxNow(skewToleranceMs = 2000): Date {
	return new Date(Date.now() - skewToleranceMs);
}

function parseOutbox(contents: string): MailOutboxEntry[] {
	const entries: MailOutboxEntry[] = [];
	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed) as MailOutboxEntry);
		} catch {
			// A torn final line means the server is mid-write; the next poll sees it whole.
		}
	}
	return entries;
}

/** Every entry currently in the outbox, oldest first. */
export async function readOutbox(
	outboxPath = mailOutboxPath(),
): Promise<MailOutboxEntry[]> {
	try {
		return parseOutbox(await readFile(outboxPath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

export interface WaitForMailOptions {
	purpose: MailPurpose;
	email: string;
	/** Ignore anything issued before this; take it with `mailOutboxNow()`. */
	since: Date;
	/** Extra predicate, e.g. matching `context.shareLinkId`. */
	match?: (entry: MailOutboxEntry) => boolean;
	timeoutMs?: number;
	pollIntervalMs?: number;
	outboxPath?: string;
}

function describeFailure(
	options: WaitForMailOptions,
	outboxPath: string,
	entries: MailOutboxEntry[],
	timeoutMs: number,
): string {
	const tail = entries.slice(-10);
	const rendered = tail.length
		? tail
				.map(
					(entry) =>
						`  ${entry.issuedAt} ${entry.purpose} ${entry.email} ${entry.code} ${JSON.stringify(entry.context)}`,
				)
				.join("\n")
		: "  (outbox is empty)";
	return [
		`No ${options.purpose} code for ${options.email} appeared within ${timeoutMs}ms.`,
		`Outbox: ${outboxPath}`,
		`Waiting for entries issued at or after ${options.since.toISOString()}.`,
		`Last ${tail.length} of ${entries.length} entries:`,
		rendered,
		entries.length === 0
			? "An empty outbox usually means the API server was started without BITTERY_ENABLE_DEV_AUTH_STUBS=true and BITTERY_DEV_MAIL_OUTBOX, or the request never reached it."
			: "Entries exist but none matched - check the address casing and the purpose.",
	].join("\n");
}

/**
 * Newest matching entry wins: a resend must supersede the code it replaced.
 */
export async function waitForMail(
	options: WaitForMailOptions,
): Promise<MailOutboxEntry> {
	const outboxPath = options.outboxPath ?? mailOutboxPath();
	const timeoutMs = options.timeoutMs ?? 30000;
	const pollIntervalMs = options.pollIntervalMs ?? 100;
	const email = options.email.trim().toLowerCase();
	const sinceMs = options.since.getTime();
	const deadline = Date.now() + timeoutMs;

	let entries: MailOutboxEntry[] = [];
	for (;;) {
		entries = await readOutbox(outboxPath);
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (!entry) continue;
			if (entry.purpose !== options.purpose) continue;
			if (entry.email.trim().toLowerCase() !== email) continue;
			if (new Date(entry.issuedAt).getTime() < sinceMs) continue;
			if (options.match && !options.match(entry)) continue;
			return entry;
		}
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	throw new Error(describeFailure(options, outboxPath, entries, timeoutMs));
}

/** The 6-digit code of the newest matching outbox entry. */
export async function waitForCode(
	options: WaitForMailOptions,
): Promise<string> {
	return (await waitForMail(options)).code;
}
