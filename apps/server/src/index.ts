import "dotenv/config";
import { createContext } from "@bittery/api/context";
import { appRouter } from "@bittery/api/routers/index";
import { createPresignedDownload } from "@bittery/storage";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createSyncRouter } from "./sync/sse-handler";

const app = new Hono();

app.use(logger());

app.use(
	"*",
	cors({
		origin: process.env.CORS_ORIGIN?.split(",") || "",
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		credentials: true,
	}),
);

// Mount sync router for SSE real-time events
const syncRouter = createSyncRouter();
app.route("/sync", syncRouter);

app.get("/cdn/*", async (c) => {
	const key = c.req.path.replace(/^\/cdn\//, "");
	if (!key) {
		return c.text("Not Found", 404);
	}

	let signedUrl: string;
	try {
		signedUrl = await createPresignedDownload({ key });
	} catch (_error) {
		return c.text("Storage not configured", 500);
	}

	const response = await fetch(signedUrl);

	if (!response.ok) {
		const status = response.status === 403 ? 404 : response.status;
		return c.text("Not Found", status as any);
	}

	const headers = new Headers(response.headers);
	headers.delete("set-cookie");
	headers.set("Cache-Control", "public, max-age=3600");

	return new Response(response.body, {
		status: response.status,
		headers,
	});
});

app.use(
	"/trpc/*",
	trpcServer({
		router: appRouter,
		onError: (err) => {
			console.error("TRPC Error:", err);
		},
		createContext: (_opts, context) => {
			return createContext({ context });
		},
	}),
);

app.get("/", (c) => {
	return c.text("OK");
});

export default {
	port: process.env.PORT || 3000,
	fetch: app.fetch,
	// Increase idle timeout for SSE connections (default is 10s)
	idleTimeout: 35, // Max value in seconds (~4 minutes)
};
