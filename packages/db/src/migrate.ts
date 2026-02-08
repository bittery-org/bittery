import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client as PgClient } from "pg";
import { join } from "node:path";

export default async function runMigrations() {
  let pgClient: PgClient | null = null;
  try {
    pgClient = new PgClient({
      connectionString: process.env.DATABASE_URL,
    });

    await pgClient.connect();
    const db = drizzle(pgClient);

    const migrationsFolder = join(
      process.cwd(),
      "../..",
      "packages/db/src/migrations",
    );

    console.log(migrationsFolder);
    console.log("Running migrations");

    // Run migrations
    await migrate(db, { migrationsFolder });
  } catch (error) {
    console.error("Error running migrations:", error);
  } finally {
    if (pgClient) {
      await pgClient.end();
    }
  }
}
