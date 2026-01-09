import "dotenv/config";
import { createContext } from "@bittery/api/context";
import { appRouter } from "@bittery/api/routers/index";
import { createPresignedDownload } from "@bittery/storage";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

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
		createContext: (_opts, context) => {
			return createContext({ context });
		},
	}),
);

app.get("/", (c) => {
	return c.text("OK");
});

export default app;
