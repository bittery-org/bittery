/**
 * Direct SQL access to the E2E databases.
 *
 * WHY THIS EXISTS - please do not "clean this up":
 *
 * A handful of states cannot be reached through the product at all: a Stripe
 * webhook's plan columns (see `./billing`), or a share link whose `expires_at`
 * has passed - the UI's shortest expiry option is one hour, and sleeping an
 * hour is not a test. Writing the column is the only way to assert what the
 * recipient sees after a link expires.
 *
 * The database is reached through the container `pnpm db:start` runs, the same
 * way `pnpm db:test:setup` does in the root `package.json`. Every caller goes
 * through the guard below, so no fixture can ever reach the dev database.
 */
import { execFileSync } from "node:child_process";

const POSTGRES_CONTAINER = "bittery-postgres";

/** Only ever the E2E databases; the dev database must survive a suite run. */
const E2E_DATABASES = new Set(["bittery_e2e", "bittery_e2e_selfhosted"]);

export const DEFAULT_E2E_DATABASE = "bittery_e2e";

/** Run one statement and return psql's own output, e.g. `UPDATE 1`. */
export function runE2eSql(
	sql: string,
	database = DEFAULT_E2E_DATABASE,
): string {
	if (!E2E_DATABASES.has(database)) {
		throw new Error(`Refusing to write to ${database}: not an E2E database.`);
	}

	return execFileSync(
		"docker",
		[
			"exec",
			POSTGRES_CONTAINER,
			"psql",
			"-U",
			"postgres",
			"-d",
			database,
			"-v",
			"ON_ERROR_STOP=1",
			"-c",
			sql,
		],
		{ encoding: "utf8" },
	).trim();
}

/** Escape a value for a single-quoted SQL literal. */
export function sqlString(value: string): string {
	return value.replace(/'/g, "''");
}
