import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Client as PgClient } from "pg";
import { join, dirname } from "node:path";

export default async function runMigrations() {
  let pgClient: PgClient | null = null;
  try {
    pgClient = new PgClient({
      connectionString: process.env.DATABASE_URL,
    });

    await pgClient.connect();
    const db = drizzle(pgClient);

    const migrationsFolder = join(
      dirname(import.meta.url.replace("file:/", "")),
      "migrations",
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
