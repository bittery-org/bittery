import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rawName = process.argv.slice(2).join(" ").trim();

if (!rawName) {
	console.error("Usage: pnpm run db:create -- <migration-name>");
	process.exit(1);
}

const slug = rawName
	.toLowerCase()
	.replace(/[^a-z0-9]+/g, "_")
	.replace(/^_+|_+$/g, "");

if (!slug) {
	console.error(
		"Migration name must contain at least one alphanumeric character",
	);
	process.exit(1);
}

const migrationsDir = resolve("apps/server/migrations");
mkdirSync(migrationsDir, { recursive: true });

// Versions are UTC timestamps (`YYYYMMDDHHMMSS`), matching sqlx's own
// `sqlx migrate add`. A sequential `max(existing) + 1` counter reads only local
// files, so two branches forking from the same point both pick the same number —
// and because the filenames differ, git merges them without a conflict and the
// collision only surfaces at migrate time. Timestamps make that near-impossible.
//
// The legacy `0000`-`0009` migrations keep their versions: sqlx stores versions
// as i64 and applies them in numeric order, so a timestamp always sorts after
// them and no already-applied migration is disturbed.
const now = new Date();
const version = [
	now.getUTCFullYear(),
	now.getUTCMonth() + 1,
	now.getUTCDate(),
	now.getUTCHours(),
	now.getUTCMinutes(),
	now.getUTCSeconds(),
]
	.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
	.join("");

const fileName = `${version}_${slug}.sql`;
const filePath = join(migrationsDir, fileName);

writeFileSync(filePath, "-- Write migration SQL here\n", { flag: "wx" });

console.log(`Created ${filePath}`);
