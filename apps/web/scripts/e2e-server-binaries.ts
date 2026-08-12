type E2eServerBinaryEnvironment = Partial<
	Pick<NodeJS.ProcessEnv, "E2E_SERVER_BINARIES_READY" | "TEST_WORKER_INDEX">
>;

// Only the primary Playwright process builds binaries that CI has not prepared.
export function shouldBuildE2eServerBinaries(
	env: E2eServerBinaryEnvironment,
): boolean {
	return !env.TEST_WORKER_INDEX && env.E2E_SERVER_BINARIES_READY !== "1";
}
