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
 * The database is the one the API servers are pointed at, reached on the port
 * below. Every caller goes through the guard below, so no fixture can ever
 * reach the dev database.
 */
import { execFileSync } from "node:child_process";

// 5436 is what apps/server/docker-compose.yml publishes locally, and what the
// CI Postgres service publishes; playwright.config.ts builds the servers'
// DATABASE_URL from this, so the fixtures and the servers cannot drift apart.
export const E2E_POSTGRES_BASE_URL =
	"postgres://postgres:password@localhost:5436";

/** The container `pnpm db:start` runs; only present on a dev machine. */
const POSTGRES_CONTAINER = "bittery-postgres";

/** Only ever the E2E databases; the dev database must survive a suite run. */
const E2E_DATABASES = new Set(["bittery_e2e", "bittery_e2e_selfhosted"]);

export const DEFAULT_E2E_DATABASE = "bittery_e2e";

let hasLocalPsql: boolean | undefined;

/**
 * Prefer a `psql` on PATH over `docker exec`: in CI Postgres is a GitHub
 * Actions service container whose name is generated per run, so the
 * `bittery-postgres` name only exists on a dev machine.
 */
function psqlCommand(database: string): [string, string[]] {
	if (hasLocalPsql === undefined) {
		try {
			execFileSync("psql", ["--version"], { stdio: "ignore" });
			hasLocalPsql = true;
		} catch {
			hasLocalPsql = false;
		}
	}

	return hasLocalPsql
		? ["psql", [`${E2E_POSTGRES_BASE_URL}/${database}`]]
		: [
				"docker",
				["exec", POSTGRES_CONTAINER, "psql", "-U", "postgres", "-d", database],
			];
}

/** Run one statement and return psql's own output, e.g. `UPDATE 1`. */
export function runE2eSql(
	sql: string,
	database = DEFAULT_E2E_DATABASE,
): string {
	if (!E2E_DATABASES.has(database)) {
		throw new Error(`Refusing to write to ${database}: not an E2E database.`);
	}

	const [command, args] = psqlCommand(database);

	return execFileSync(command, [...args, "-v", "ON_ERROR_STOP=1", "-c", sql], {
		encoding: "utf8",
	}).trim();
}

/** Escape a value for a single-quoted SQL literal. */
export function sqlString(value: string): string {
	return value.replace(/'/g, "''");
}
