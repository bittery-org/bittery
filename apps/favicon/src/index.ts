import dotenv from "dotenv";

// Reuse the server env file by default so favicon service matches server config.
dotenv.config({
	path: "../../server/.env",
});

import { faviconApp } from "@bittery/favicon";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

const app = new Hono();

app.use(logger());
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
	}),
);

app.route("/favicon", faviconApp);

app.get("/healthz", (c) => {
	return c.json({ status: "ok" });
});

app.get("/", (c) => {
	return c.text("OK");
});

export default {
	port: process.env.PORT || 3010,
	hostname: process.env.HOST || "0.0.0.0",
	fetch: app.fetch,
};
