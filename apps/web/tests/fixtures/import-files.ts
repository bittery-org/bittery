/**
 * The export files the import specs feed to the import dialog.
 *
 * Everything a provider's own unit tests already pin byte-for-byte is reused
 * from `packages/shared/src/__tests__/fixtures` rather than copied: those files
 * are real sanitized exports, their SHA-256 is asserted in the unit suite, and
 * `biome.json` excludes that directory from formatting so the bytes stay put. A
 * second copy under `apps/web` would drift the moment one of them is refreshed.
 *
 * Only the two files no provider suite owns live here: the 1PUX payload (its
 * unit test builds the archive in memory and commits nothing) and an encrypted
 * Bitwarden export, which exists purely to reach a parse error.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const testsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

/** Where the provider suites keep their pinned exports. */
const sharedFixturesDir = path.resolve(
	testsDir,
	"../../../packages/shared/src/__tests__/fixtures",
);

/** Files authored for this suite, because no provider suite commits one. */
const localFixturesDir = path.join(testsDir, "fixtures/import-files");

/** An export file reused from the provider suite that pins it. */
export const sharedFixture = {
	bitwardenJson: path.join(
		sharedFixturesDir,
		"bitwarden/individual-export.json",
	),
	bitwardenCsv: path.join(sharedFixturesDir, "bitwarden/individual-export.csv"),
	chromeCsv: path.join(sharedFixturesDir, "chrome/chromium-sorted.csv"),
	firefoxCsv: path.join(sharedFixturesDir, "firefox/logins.csv"),
	keepassxcCsv: path.join(
		sharedFixturesDir,
		"keepassxc/keepassxc-2.7.8-macos.csv",
	),
} as const;

/** An export file authored for this suite. */
export const localFixture = {
	onePasswordExportData: path.join(
		localFixturesDir,
		"1password-export.data.json",
	),
	bitwardenEncryptedJson: path.join(
		localFixturesDir,
		"bitwarden-encrypted-export.json",
	),
} as const;

/** A per-run scratch directory for the archives built below. */
export function createFixtureScratchDir(): string {
	return mkdtempSync(path.join(tmpdir(), "bittery-e2e-import-"));
}

/**
 * Zip the committed 1PUX payload into a real `.1pux` archive.
 *
 * A 1PUX is a ZIP holding `export.data`, so the archive is built here instead of
 * committed: the payload stays reviewable as JSON, and the bytes Playwright
 * uploads are produced by the same JSZip the app itself reads them back with.
 */
export async function buildOnePasswordArchive(
	scratchDir: string,
): Promise<string> {
	const archive = new JSZip();
	archive.file(
		"export.data",
		readFileSync(localFixture.onePasswordExportData, "utf8"),
	);
	const bytes = await archive.generateAsync({ type: "nodebuffer" });
	const archivePath = path.join(scratchDir, "1password-export.1pux");
	writeFileSync(archivePath, bytes);
	return archivePath;
}

/**
 * The `export.json` payload inside a `.bttrx` archive the app produced, so a
 * round-trip spec can assert what was exported before feeding it back in.
 */
export async function readBttrxPayload(archivePath: string): Promise<{
	version: string;
	vaults: { id: string; name: string }[];
	items: { id: string; vaultId: string; data: { title?: string } }[];
	metadata: { totalItems: number; totalVaults: number };
}> {
	const archive = await JSZip.loadAsync(readFileSync(archivePath));
	const entry = archive.file("export.json");
	if (!entry) {
		throw new Error(
			`No export.json in ${archivePath}; the archive holds ${Object.keys(archive.files).join(", ")}`,
		);
	}
	return JSON.parse(await entry.async("string"));
}
