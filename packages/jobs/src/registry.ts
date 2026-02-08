import type { JobDefinition } from "./types";

/**
 * Central job registry.
 * All jobs auto-register by calling `registerJob()` at module level.
 */
const jobs: JobDefinition[] = [];

export function registerJob<TData = unknown>(job: JobDefinition<TData>): void {
	jobs.push(job as JobDefinition);
}

export function getRegisteredJobs(): ReadonlyArray<JobDefinition> {
	return jobs;
}
