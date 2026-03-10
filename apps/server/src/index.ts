import "dotenv/config";
import {
	isStripeWebhookConfigured,
	parseStripeWebhookEvent,
	processStripeWebhookEvent,
} from "@bittery/api/billing/stripe";
import { isSelfHostedMode } from "@bittery/api/config/mode";
import { createContext } from "@bittery/api/context";
import { appRouter } from "@bittery/api/routers/index";
import { createPresignedDownload } from "@bittery/api/storage/s3";
import runMigrations from "@bittery/db/migrate";
import { JobRunner } from "@bittery/jobs";
import { createPubSubAdapter } from "@bittery/pubsub";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createSyncRouter } from "./sync/sse-handler";

await runMigrations();

const app = new Hono();

app.use(logger());

app.use(
	"*",
	cors({
		origin: process.env.CORS_ORIGIN?.split(",") || "",
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: [
			"Content-Type",
			"Authorization",
			"X-Client-Id",
			"X-App-Platform",
		],
		exposeHeaders: ["X-Session-Expires"],
		credentials: true,
	}),
);

// Initialize PubSub adapter (Redis if REDIS_URL is set, in-memory otherwise)
const pubsub = await createPubSubAdapter();

// Mount sync router for SSE real-time events
const syncRouter = createSyncRouter(pubsub);
app.route("/sync", syncRouter);

// Start pg-boss job runner (replaces setInterval-based pruning)
const jobRunner = new JobRunner({
	// @ts-expect-error - we now its defined
	connectionString: process.env.DATABASE_URL,
});
await jobRunner.start();

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
		onError: ({ error, path }) => {
			console.error(`tRPC Error [${path}]: ${error.message} (${error.code})`);
		},
		createContext: (_opts, context) => {
			return createContext({ context });
		},
	}),
);

app.get("/healthz", (c) => {
	return c.json({ status: "ok" });
});

app.get("/", (c) => {
	return c.text("OK");
});

app.post("/webhooks/stripe", async (c) => {
	if (isSelfHostedMode()) {
		return c.text("Not Found", 404);
	}

	if (!isStripeWebhookConfigured()) {
		return c.text("Stripe webhook not configured", 503);
	}

	const rawBody = await c.req.text();
	const signatureHeader = c.req.header("stripe-signature") || null;

	try {
		const event = await parseStripeWebhookEvent(rawBody, signatureHeader);
		const result = await processStripeWebhookEvent(rawBody, event);

		return c.json({
			received: true,
			duplicate: result.duplicate,
		});
	} catch (error) {
		console.error("Stripe webhook error:", error);
		return c.text("Invalid Stripe webhook", 400);
	}
});

export default {
	port: process.env.PORT || 3000,
	hostname: process.env.HOST || "0.0.0.0", // Allow connections from other devices on the network
	fetch: app.fetch,
	// Increase idle timeout for SSE connections (default is 10s)
	idleTimeout: 35, // Max value in seconds (~4 minutes)
};
