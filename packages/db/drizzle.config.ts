import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

console.log(process.env.DATABASE_URL); // Debug: Check if DATABASE_URL is loaded correctly

dotenv.config({
	path: "../../apps/server/.env",
});

export default defineConfig({
	schema: "./src/schema",
	out: "./src/migrations",
	dialect: "postgresql",
	dbCredentials: {
		url: process.env.DATABASE_URL || "",
	},
});
