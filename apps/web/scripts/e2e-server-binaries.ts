type E2eServerBinaryEnvironment = Partial<
	Pick<NodeJS.ProcessEnv, "E2E_SERVER_BINARIES_READY" | "TEST_WORKER_INDEX">
>;

/**
 * The config owns the pre-server build only when it is the primary Playwright
 * process and no explicit CI preparation step has already produced the binaries.
 */
export function shouldBuildE2eServerBinaries(
	env: E2eServerBinaryEnvironment,
): boolean {
	return !env.TEST_WORKER_INDEX && env.E2E_SERVER_BINARIES_READY !== "1";
}
