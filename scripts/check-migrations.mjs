import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// Guards the two migration mistakes sqlx cannot catch for us until deploy time:
//
//  1. Duplicate versions. sqlx sorts migrations by version but never rejects two
//     files sharing one (`sqlx-core/src/migrate/source.rs`). On a fresh database
//     both get applied and the second dies on the `_sqlx_migrations` primary key;
//     on an existing one you get `VersionMismatch`. Git does not flag it either,
//     because the two files have different names and merge cleanly.
//
//  2. Edits to an already-merged migration. sqlx compares checksums against the
//     applied row, so changing a migration that has run anywhere fails that
//     database permanently with `VersionMismatch`. Fix forward with a new
//     migration instead.
//
// Usage: node scripts/check-migrations.mjs [baseRef]
// Without a baseRef only check 1 runs (nothing to diff against).

const MIGRATIONS_DIR = "apps/server/migrations";
const baseRef = process.argv[2];
const errors = [];

const fileNames = readdirSync(resolve(MIGRATIONS_DIR))
	.filter((fileName) => fileName.endsWith(".sql"))
	.sort();

const versions = new Map();

for (const fileName of fileNames) {
	const match = /^([0-9]+)_.*\.sql$/.exec(fileName);
	if (!match) {
		errors.push(
			`${fileName}: name must be <version>_<slug>.sql — create migrations with 'pnpm run db:create -- <name>'`,
		);
		continue;
	}

	const version = match[1];
	const existing = versions.get(version);
	if (existing) {
		errors.push(
			`duplicate migration version ${version}: ${existing} and ${fileName}. Recreate the newer one with 'pnpm run db:create -- <name>' to get a fresh timestamp.`,
		);
		continue;
	}
	versions.set(version, fileName);
}

if (baseRef) {
	// Renames surface as delete + add, which is exactly what we want to reject:
	// the old version may already be applied somewhere.
	const changed = execFileSync(
		"git",
		["diff", "--name-status", `${baseRef}...HEAD`, "--", MIGRATIONS_DIR],
		{ encoding: "utf8" },
	)
		.split("\n")
		.filter(Boolean);

	for (const line of changed) {
		const [status, path] = line.split("\t");
		if (status === "A") {
			continue;
		}
		const verb = status.startsWith("D") ? "deleted" : "modified";
		errors.push(
			`${path} was ${verb}, but it already exists on ${baseRef}. Migrations are immutable once merged — add a new migration instead.`,
		);
	}
}

if (errors.length > 0) {
	console.error("Migration check failed:\n");
	for (const error of errors) {
		console.error(`  - ${error}`);
	}
	process.exit(1);
}

console.log(`Migration check passed (${versions.size} migrations).`);
