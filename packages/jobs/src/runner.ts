import PgBoss from "pg-boss";
import { getRegisteredJobs } from "./registry";

// Import all job modules to trigger auto-registration
import "./jobs/sync-pruning";

export interface JobRunnerOptions {
	connectionString: string;
}

/**
 * Job runner backed by pg-boss.
 * Manages lifecycle, registration, and scheduling of all registered jobs.
 */
export class JobRunner {
	private boss: PgBoss;

	constructor(options: JobRunnerOptions) {
		this.boss = new PgBoss({
			connectionString: options.connectionString,
			schema: "pgboss",
		});

		this.boss.on("error", (err) => {
			console.error("[jobs] pg-boss error:", err);
		});
	}

	/**
	 * Start pg-boss (auto-creates schema), register all jobs, and schedule cron jobs.
	 */
	async start(): Promise<void> {
		await this.boss.start();
		console.log("[jobs] pg-boss started");

		const jobs = getRegisteredJobs();

		for (const job of jobs) {
			const { name, schedule, retry, expireInSeconds } = job.options;

			// Create the queue with expiration settings
			await this.boss.createQueue(name, {
				name,
				...(expireInSeconds ? { expireInSeconds } : {}),
			});

			// Register the worker (simple two-arg form)
			await this.boss.work(name, async () => {
				console.log(`[jobs] Running: ${name}`);
				try {
					await job.handler(undefined);
					console.log(`[jobs] Completed: ${name}`);
				} catch (err) {
					console.error(`[jobs] Failed: ${name}`, err);
					throw err;
				}
			});

			// Schedule cron jobs
			if (schedule) {
				await this.boss.schedule(name, schedule.cron, undefined, {
					tz: schedule.tz ?? "UTC",
					...(retry?.retryLimit != null
						? { retryLimit: retry.retryLimit }
						: {}),
					...(retry?.retryDelay != null
						? { retryDelay: retry.retryDelay }
						: {}),
					...(retry?.retryBackoff != null
						? { retryBackoff: retry.retryBackoff }
						: {}),
				});
				console.log(`[jobs] Scheduled: ${name} (cron: ${schedule.cron})`);
			}
		}
	}

	/**
	 * Enqueue a one-off job by name.
	 */
	async enqueue<TData extends object>(
		name: string,
		data?: TData,
	): Promise<string | null> {
		return this.boss.send(name, data ?? {});
	}

	/**
	 * Graceful shutdown with 30s timeout.
	 */
	async stop(): Promise<void> {
		await this.boss.stop({ graceful: true, timeout: 30_000 });
		console.log("[jobs] pg-boss stopped");
	}
}
