import type { SyncCommandSummary } from "./types";

export function getNewTerminalCommandCount(
	previous: SyncCommandSummary,
	next: SyncCommandSummary,
): number {
	return (
		Math.max(0, next.failed - previous.failed) +
		Math.max(0, next.conflicted - previous.conflicted)
	);
}

interface CommandSummarySource {
	getCommandSummary(): SyncCommandSummary;
	subscribe(listener: () => void): () => void;
}

export function subscribeToNewTerminalCommands(
	source: CommandSummarySource,
	listener: (newTerminalCount: number) => void,
): () => void {
	let previous = source.getCommandSummary();
	return source.subscribe(() => {
		const next = source.getCommandSummary();
		const newTerminalCount = getNewTerminalCommandCount(previous, next);
		previous = next;
		if (newTerminalCount > 0) {
			listener(newTerminalCount);
		}
	});
}
