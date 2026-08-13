import type { ConnectionStatus, SyncCommandSummary } from "@bittery/sync";

export interface PopupWorkerState {
	status?: ConnectionStatus;
	clientId?: string;
	commandSummary?: SyncCommandSummary;
}

export interface PopupWorkerStateSource {
	status(): Promise<ConnectionStatus | undefined>;
	clientId(): Promise<string | undefined>;
	commandSummary(): Promise<SyncCommandSummary | undefined>;
	recoverStaged(): Promise<void>;
}

/** Worker availability may enrich popup state, but no individual request gates it. */
export async function loadPopupWorkerState(
	source: PopupWorkerStateSource,
): Promise<PopupWorkerState> {
	const [status, clientId, commandSummary] = await Promise.allSettled([
		source.status(),
		source.clientId(),
		source.commandSummary(),
		source.recoverStaged(),
	]);
	return {
		status: status.status === "fulfilled" ? status.value : undefined,
		clientId: clientId.status === "fulfilled" ? clientId.value : undefined,
		commandSummary:
			commandSummary.status === "fulfilled" ? commandSummary.value : undefined,
	};
}
