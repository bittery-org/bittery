import {
	useRuntimeClient,
	useRuntimeItems,
	useRuntimeSession,
} from "@bittery/client-runtime/react";
import { observeAccountDeparture } from "@bittery/ui/runtime-presentation";
import { useCallback, useEffect, useRef, useState } from "react";
import { attachmentDownloadSinks } from "@/lib/crypto";
import {
	createRuntimeVaultArchive,
	type ExportProgress,
	type RuntimeVaultArchive,
} from "@/lib/runtime-vault-export";

export type { ExportProgress, ExportStage } from "@/lib/runtime-vault-export";

function createEmptyProgress(): ExportProgress {
	return {
		stage: "idle",
		totalItems: 0,
		processedItems: 0,
		totalAttachments: 0,
		processedAttachments: 0,
	};
}

export function useVaultExport() {
	const runtime = useRuntimeClient();
	const session = useRuntimeSession();
	const accountId = session.state === "unlocked" ? session.accountId : null;
	useRuntimeItems(accountId);
	const [progress, setProgress] = useState<ExportProgress>(createEmptyProgress);
	const [archiveReady, setArchiveReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const archive = useRef<RuntimeVaultArchive | null>(null);
	const attempt = useRef<AbortController | null>(null);
	const repeatable = useRef(false);
	const downloading = useRef(false);
	const reset = useCallback(() => {
		attempt.current?.abort();
		attempt.current = null;
		const old = archive.current;
		archive.current = null;
		void old?.dispose().catch(() => undefined);
		repeatable.current = false;
		setProgress(createEmptyProgress());
		setArchiveReady(false);
		setError(null);
	}, []);
	useEffect(() => {
		reset();
		const release = observeAccountDeparture(runtime, accountId, reset);
		return () => {
			release();
			attempt.current?.abort();
			void archive.current?.dispose().catch(() => undefined);
			archive.current = null;
		};
	}, [runtime, accountId, reset]);
	const prepare = useCallback(
		async (controller: AbortController) => {
			attempt.current = controller;
			setArchiveReady(false);
			setProgress({ ...createEmptyProgress(), stage: "fetching" });
			const prepared = await createRuntimeVaultArchive(
				runtime,
				attachmentDownloadSinks,
				(next) => {
					if (attempt.current !== controller || controller.signal.aborted)
						return;
					if (next.stage === "idle") {
						controller.abort();
						archive.current = null;
						repeatable.current = false;
						setArchiveReady(false);
					}
					setProgress(next);
				},
				controller.signal,
			);
			if (attempt.current !== controller || controller.signal.aborted) {
				await prepared.dispose();
				throw new DOMException("Export cancelled", "AbortError");
			}
			archive.current = prepared;
			setArchiveReady(true);
			return prepared;
		},
		[runtime],
	);
	const startExport = useCallback(async () => {
		reset();
		const controller = new AbortController();
		try {
			await prepare(controller);
		} catch (failure) {
			if (attempt.current !== controller || controller.signal.aborted) return;
			setError(failure instanceof Error ? failure.message : "Unknown error");
			setProgress({ ...createEmptyProgress(), stage: "error" });
		}
	}, [prepare, reset]);
	const downloadArchive = useCallback(async () => {
		if (downloading.current || (!archive.current && !repeatable.current))
			return;
		downloading.current = true;
		setArchiveReady(false);
		const existing = archive.current;
		const controller = existing ? attempt.current : new AbortController();
		if (!controller) {
			downloading.current = false;
			return;
		}
		let current = existing;
		try {
			// Finish consumes its original output. Repeating Download starts fresh Core capture.
			current = existing ?? (await prepare(controller));
			await current.download();
			if (archive.current === current) archive.current = null;
			if (attempt.current === controller && !controller.signal.aborted) {
				repeatable.current = true;
				setArchiveReady(true);
				// Retain no previous Vault names, Item counts or private output in the completed view.
				setProgress({ ...createEmptyProgress(), stage: "completed" });
			}
		} catch (failure) {
			void current?.dispose().catch(() => undefined);
			if (attempt.current !== controller || controller.signal.aborted) return;
			archive.current = null;
			repeatable.current = false;
			setArchiveReady(false);
			setError(failure instanceof Error ? failure.message : "Unknown error");
			setProgress({ ...createEmptyProgress(), stage: "error" });
		} finally {
			downloading.current = false;
		}
	}, [prepare]);
	return { progress, archiveReady, error, reset, startExport, downloadArchive };
}
