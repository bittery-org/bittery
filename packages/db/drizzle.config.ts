import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

console.log(process.env.DATABASE_URL);

dotenv.config({
	path: "../../apps/server/.env",
	debug: true,
});

console.log(process.env.DATABASE_URL);

export default defineConfig({
	schema: "./src/schema",
	out: "./src/migrations",
	dialect: "postgresql",
	dbCredentials: {
		url: process.env.DATABASE_URL || "",
	},
});
