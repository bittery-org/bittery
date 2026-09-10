import {
	useRuntimeClient,
	useRuntimeItems,
	useRuntimeSession,
} from "@bittery/client-runtime/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { attachmentDownloadSinks } from "@/lib/crypto";
import { observeAccountDeparture } from "@/lib/runtime-account-presentation";
import {
	createRuntimeVaultArchive,
	type ExportProgress,
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
	// Keeps the shared projection ready while the dialog is mounted.
	useRuntimeItems(accountId);
	const [progress, setProgress] = useState<ExportProgress>(createEmptyProgress);
	const [archive, setArchive] = useState<{
		accountId: string | null;
		blob: Blob;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const attempt = useRef<AbortController | null>(null);
	const reset = useCallback(() => {
		attempt.current?.abort();
		attempt.current = null;
		setProgress(createEmptyProgress());
		setArchive(null);
		setError(null);
	}, []);
	useEffect(() => {
		reset();
		const release = observeAccountDeparture(runtime, accountId, reset);
		return () => {
			release();
			attempt.current?.abort();
		};
	}, [runtime, accountId, reset]);
	const startExport = useCallback(async () => {
		reset();
		const controller = new AbortController();
		attempt.current = controller;
		setProgress({ ...createEmptyProgress(), stage: "fetching" });
		try {
			const blob = await createRuntimeVaultArchive(
				runtime,
				attachmentDownloadSinks,
				(next) => {
					if (!controller.signal.aborted) setProgress(next);
				},
				controller.signal,
			);
			if (!controller.signal.aborted) setArchive({ accountId, blob });
		} catch (failure) {
			if (controller.signal.aborted) return;
			setError(failure instanceof Error ? failure.message : "Unknown error");
			setProgress((previous) => ({ ...previous, stage: "error" }));
		}
	}, [runtime, accountId, reset]);
	const archiveBlob = archive?.accountId === accountId ? archive.blob : null;
	const downloadArchive = useCallback(() => {
		if (!archiveBlob || !accountId) return;
		const current = runtime.session().getSnapshot();
		if (current.state !== "unlocked" || current.accountId !== accountId) return;
		const url = URL.createObjectURL(archiveBlob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = "bittery-export.bttrx";
		anchor.click();
		URL.revokeObjectURL(url);
	}, [archiveBlob, accountId, runtime]);
	return { progress, archiveBlob, error, reset, startExport, downloadArchive };
}
