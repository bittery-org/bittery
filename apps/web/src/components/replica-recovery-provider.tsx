import type {
	RecoveryBound,
	RuntimeClient,
	StorageRecoveryDiagnostics,
} from "@bittery/client-runtime/client";
import type { WebClientRuntime } from "@bittery/client-runtime/web";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
} from "@bittery/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { RecoveryEntryContext } from "./recovery-entry";

type RecoveryFailure = {
	code:
		| "unknown"
		| "copyFailed"
		| "QUOTA_EXCEEDED"
		| "SIZE_REJECTED"
		| "STORAGE_UNAVAILABLE";
	bound?: RecoveryBound;
};

type Prepared = {
	capabilityId: string;
	classification: "complete" | "partial" | "unknown";
	byteLength: string;
	downloadRequested: boolean;
};
/** One presentation owner survives normal route/status changes while Core retires every Account. */
export function ReplicaRecoveryProvider({
	children,
	client,
	files,
	retry = () => window.location.reload(),
}: {
	children: ReactNode;
	client: RuntimeClient;
	files: WebClientRuntime["recoveryFiles"];
	retry?: () => void;
}) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [diagnostics, setDiagnostics] = useState<StorageRecoveryDiagnostics>();
	const [accountId, setAccountId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<RecoveryFailure>();
	const [copied, setCopied] = useState(false);
	const [repaired, setRepaired] = useState(false);
	const [scanLimited, setScanLimited] = useState(false);
	const [prepared, setPrepared] = useState<Prepared[]>([]);
	const attempt = useRef<AbortController | undefined>(undefined);
	const mounted = useRef(true);
	const urls = useRef(new Map<string, string>());
	const password = useRef<HTMLInputElement>(null);
	const archive = useRef<HTMLInputElement>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			attempt.current?.abort();
		};
	}, []);
	const boundLabels = {
		recordBytes: m.replica_recovery_bound_record_bytes(),
		archiveBytes: m.replica_recovery_bound_archive_bytes(),
		recordCount: m.replica_recovery_bound_record_count(),
		artifactCount: m.replica_recovery_bound_artifact_count(),
		reportBytes: m.replica_recovery_bound_report_bytes(),
		summaryBytes: m.replica_recovery_bound_summary_bytes(),
		controlBytes: m.replica_recovery_bound_control_bytes(),
		cursorBytes: m.replica_recovery_bound_cursor_bytes(),
		chunkBytes: m.replica_recovery_bound_chunk_bytes(),
	} satisfies Record<RecoveryBound, string>;
	const errorMessage =
		error?.code === "SIZE_REJECTED" && error.bound !== undefined
			? m.replica_recovery_limit({ bound: boundLabels[error.bound] })
			: {
					QUOTA_EXCEEDED: m.replica_recovery_quota(),
					STORAGE_UNAVAILABLE: m.replica_recovery_storage_error(),
					SIZE_REJECTED: m.replica_recovery_limit_unknown(),
					copyFailed: m.replica_recovery_copy_failed(),
					unknown: m.replica_recovery_error(),
				}[error?.code ?? "unknown"];
	const run = async (action: (signal: AbortSignal) => Promise<void>) => {
		if (!mounted.current || attempt.current !== undefined) return;
		const controller = new AbortController();
		attempt.current = controller;
		setBusy(true);
		setError(undefined);
		try {
			await action(controller.signal);
		} catch (failure) {
			if (mounted.current && !controller.signal.aborted) {
				const value = failure as {
					code?: unknown;
					recoveryBound?: unknown;
				} | null;
				const code = value?.code;
				const bound = value?.recoveryBound;
				setError({
					code:
						code === "QUOTA_EXCEEDED" ||
						code === "SIZE_REJECTED" ||
						code === "STORAGE_UNAVAILABLE"
							? code
							: "unknown",
					...(code === "SIZE_REJECTED" &&
					typeof bound === "string" &&
					Object.hasOwn(boundLabels, bound)
						? { bound: bound as RecoveryBound }
						: {}),
				});
			}
		} finally {
			if (attempt.current === controller) attempt.current = undefined;
			if (mounted.current) setBusy(false);
		}
	};
	const inspect = () =>
		run(async (signal) => {
			const result = await client.inspectRecovery({}, { signal });
			if (signal.aborted || !mounted.current) return;
			setDiagnostics(result);
			setCopied(false);
			setAccountId((current) =>
				result.accounts.some((account) => account.accountId === current)
					? current
					: (result.accounts[0]?.accountId ?? ""),
			);
		});
	const selected = diagnostics?.accounts.find(
		(account) => account.accountId === accountId,
	);
	const copyDiagnostics = () =>
		run(async (signal) => {
			if (diagnostics === undefined) return;
			setCopied(false);
			// Copy the closed metadata projection, never arbitrary response extensions or other Accounts.
			const report = {
				maintenance: diagnostics.maintenance,
				schema: diagnostics.schema,
				device: diagnostics.device,
				failure: diagnostics.failure,
				account:
					selected === undefined
						? null
						: {
								accountId: selected.accountId,
								email: selected.email,
								serverUrl: selected.serverUrl,
								userId: selected.userId,
								state: selected.state,
								operationCount: selected.operationCount,
								receiptCount: selected.receiptCount,
								missingArtifacts: selected.missingArtifacts,
								canExport: selected.canExport,
								canRepair: selected.canRepair,
								canRebootstrap: selected.canRebootstrap,
							},
			};
			try {
				await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
				if (mounted.current && !signal.aborted) setCopied(true);
			} catch {
				if (mounted.current && !signal.aborted)
					setError({ code: "copyFailed" });
			}
		});
	const execute = (mode: "export" | "repair") => {
		if (busy || selected === undefined) return;
		const secret = password.current?.value ?? "";
		if (password.current) password.current.value = "";
		const source = archive.current?.files?.[0];
		if (archive.current) archive.current.value = "";
		void run(async (signal) => {
			if (mode === "export") {
				const capabilityId = files.grantSink(accountId);
				const result = await client
					.exportAccountRecovery(
						{ accountId, password: secret, sinkCapabilityId: capabilityId },
						{ signal },
					)
					.finally(() => files.discardGrant(capabilityId));
				if (signal.aborted || !mounted.current) return;
				const file = files.prepared(capabilityId).file;
				if (BigInt(file.size) !== BigInt(result.byteLength))
					throw new Error("Prepared recovery file length mismatch");
				setPrepared((current) => [
					...current,
					{
						capabilityId,
						classification: result.classification,
						byteLength: result.byteLength,
						downloadRequested: false,
					},
				]);
			} else {
				if (source === undefined) throw new Error("Recovery File is missing");
				const capabilityId = files.grantSource(accountId, source);
				await client
					.repairAccountRecovery(
						{ accountId, password: secret, sourceCapabilityId: capabilityId },
						{ signal },
					)
					.finally(() => files.discardGrant(capabilityId));
				if (!signal.aborted && mounted.current) setRepaired(true);
			}
		});
	};
	const download = (item: Prepared) => {
		const file = files.prepared(item.capabilityId).file;
		let url = urls.current.get(item.capabilityId);
		if (url === undefined) {
			url = URL.createObjectURL(file);
			urls.current.set(item.capabilityId, url);
		}
		const link = document.createElement("a");
		link.href = url;
		link.download = "bittery-account-recovery.btrrec";
		link.click();
		files.downloadRequested(item.capabilityId);
		setPrepared((current) =>
			current.map((value) =>
				value.capabilityId === item.capabilityId
					? { ...value, downloadRequested: true }
					: value,
			),
		);
	};
	const release = (item: Prepared) =>
		run(async () => {
			await files.release(item.capabilityId);
			const url = urls.current.get(item.capabilityId);
			if (url !== undefined) {
				URL.revokeObjectURL(url);
				urls.current.delete(item.capabilityId);
			}
			if (mounted.current)
				setPrepared((current) =>
					current.filter((value) => value.capabilityId !== item.capabilityId),
				);
		});
	const status = diagnostics?.maintenance;
	const stateLabel =
		selected === undefined
			? ""
			: {
					ready: m.replica_recovery_state_ready(),
					corrupt: m.replica_recovery_state_corrupt(),
					missing: m.replica_recovery_state_missing(),
					unknown: m.replica_recovery_state_unknown(),
					unreadable: m.replica_recovery_state_unreadable(),
				}[selected.state];
	return (
		<RecoveryEntryContext.Provider value={() => setOpen(true)}>
			{children}
			<Dialog
				open={open}
				onOpenChange={(value) => {
					if (!busy) {
						if (password.current) password.current.value = "";
						if (archive.current) archive.current.value = "";
						setOpen(value);
					}
				}}
			>
				<DialogContent
					className="max-h-[90dvh] max-w-xl overflow-y-auto"
					data-testid="replica-recovery-dialog"
				>
					<DialogHeader>
						<DialogTitle>{m.replica_recovery_title()}</DialogTitle>
						<DialogDescription>
							{m.replica_recovery_description()}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4">
						<p className="text-muted-foreground text-sm">
							{m.replica_recovery_pause_description()}
						</p>
						<div className="flex gap-2">
							<Button onClick={() => void inspect()} disabled={busy}>
								{diagnostics
									? m.replica_recovery_inspect_again()
									: m.replica_recovery_inspect()}
							</Button>
							<Button variant="outline" onClick={retry} disabled={busy}>
								{m.replica_recovery_retry_normal()}
							</Button>
						</div>
						{diagnostics !== undefined && (
							<div className="space-y-2">
								<Button
									variant="outline"
									disabled={busy}
									onClick={() => void copyDiagnostics()}
								>
									{m.replica_recovery_copy_diagnostics()}
								</Button>
								{copied && (
									<p role="status" className="text-muted-foreground text-sm">
										{m.replica_recovery_diagnostics_copied()}
									</p>
								)}
							</div>
						)}
						{diagnostics?.failure === "QUOTA_EXCEEDED" && (
							<p role="status" className="text-muted-foreground text-sm">
								{m.replica_recovery_quota()}
							</p>
						)}
						{error && (
							<p role="alert" className="text-destructive text-sm">
								{errorMessage}
							</p>
						)}
						{busy && (
							<div className="flex items-center gap-2">
								<p role="status" className="text-muted-foreground text-sm">
									{m.replica_recovery_working()}
								</p>
								<Button
									variant="outline"
									onClick={() => attempt.current?.abort()}
								>
									{m.replica_recovery_cancel()}
								</Button>
							</div>
						)}
						{status !== undefined && status !== "available" && (
							<p role="status" className="text-muted-foreground text-sm">
								{status === "busy"
									? m.replica_recovery_busy()
									: status === "unsupported"
										? m.replica_recovery_unsupported()
										: m.replica_recovery_unavailable()}
							</p>
						)}
						{diagnostics?.schema === "unsupported" && (
							<p role="status" className="text-muted-foreground text-sm">
								{m.replica_recovery_schema_unsupported()}
							</p>
						)}
						{diagnostics?.device === "freshOrUnknown" && (
							<p role="status" className="text-muted-foreground text-sm">
								{m.replica_recovery_fresh_unknown()}
							</p>
						)}
						{diagnostics !== undefined && diagnostics.accounts.length > 0 && (
							<>
								<Label htmlFor="recovery-account">
									{m.replica_recovery_account()}
								</Label>
								<select
									id="recovery-account"
									className="w-full rounded-md border bg-background px-3 py-2 text-sm"
									value={accountId}
									disabled={busy}
									onChange={(event) => {
										setAccountId(event.target.value);
										setCopied(false);
										if (password.current) password.current.value = "";
										if (archive.current) archive.current.value = "";
									}}
								>
									{diagnostics.accounts.map((account) => (
										<option key={account.accountId} value={account.accountId}>
											{account.email ?? account.accountId}
											{account.serverUrl ? ` · ${account.serverUrl}` : ""}
										</option>
									))}
								</select>
								{selected !== undefined && (
									<div
										className="rounded-md border bg-card p-3 text-sm"
										data-testid="recovery-account-diagnostics"
									>
										<p>{stateLabel}</p>
										<p className="break-all text-muted-foreground">
											{selected.serverUrl}
										</p>
										<p>
											{m.replica_recovery_operations()}:{" "}
											{selected.operationCount ?? m.replica_recovery_unknown()}
										</p>
										<p>
											{m.replica_recovery_receipts()}:{" "}
											{selected.receiptCount ?? m.replica_recovery_unknown()}
										</p>
										<p>
											{m.replica_recovery_missing_artifacts()}:{" "}
											{selected.missingArtifacts ??
												m.replica_recovery_unknown()}
										</p>
									</div>
								)}
								<div className="space-y-2">
									<p className="text-muted-foreground text-sm">
										{m.replica_recovery_rebootstrap_description()}
									</p>
									<Button
										variant="outline"
										disabled={busy || selected?.canRebootstrap !== true}
										onClick={() =>
											void run(async (signal) => {
												await client.rebootstrapAccountRecovery(
													{ accountId },
													{ signal },
												);
												if (!signal.aborted && mounted.current)
													setRepaired(true);
											})
										}
									>
										{m.replica_recovery_rebootstrap()}
									</Button>
								</div>
								<form
									className="space-y-3"
									onSubmit={(event) => {
										event.preventDefault();
										execute("export");
									}}
								>
									<Label htmlFor="recovery-password">
										{m.replica_recovery_password()}
									</Label>
									<Input
										ref={password}
										id="recovery-password"
										type="password"
										autoComplete="new-password"
										required
										disabled={busy}
									/>
									<p className="text-muted-foreground text-xs">
										{m.replica_recovery_password_description()}
										<br />
										{m.replica_recovery_network_pending()}
									</p>
									<Label htmlFor="recovery-archive">
										{m.replica_recovery_archive()}
									</Label>
									<Input
										ref={archive}
										id="recovery-archive"
										type="file"
										accept=".btrrec"
										disabled={busy}
									/>
									<div className="flex flex-wrap gap-2">
										<Button
											type="submit"
											disabled={busy || selected?.canExport !== true}
										>
											{m.replica_recovery_export()}
										</Button>
										<Button
											type="button"
											variant="outline"
											disabled={busy || selected?.canRepair !== true}
											onClick={(event) => {
												const form = event.currentTarget.form;
												if (form?.reportValidity()) execute("repair");
											}}
										>
											{m.replica_recovery_repair()}
										</Button>
									</div>
								</form>
							</>
						)}
						{repaired && (
							<p role="status" className="text-sm text-success">
								{m.replica_recovery_repaired()}
							</p>
						)}
						<Button
							variant="outline"
							disabled={busy}
							onClick={() =>
								void run(async (signal) => {
									const result = await files.listRetained();
									if (signal.aborted || !mounted.current) return;
									setScanLimited(result.limited);
									setPrepared((current) => {
										const entries = new Map(
											current.map((item) => [item.capabilityId, item]),
										);
										for (const file of result.files)
											if (!entries.has(file.capabilityId))
												entries.set(file.capabilityId, {
													capabilityId: file.capabilityId,
													byteLength: file.byteLength,
													classification: "unknown",
													downloadRequested: file.state === "downloadRequested",
												});
										return [...entries.values()];
									});
								})
							}
						>
							{m.replica_recovery_retained_scan()}
						</Button>
						{scanLimited && (
							<p role="status" className="text-muted-foreground text-sm">
								{m.replica_recovery_retained_limit()}
							</p>
						)}
						{prepared.map((item) => (
							<section
								key={item.capabilityId}
								className="space-y-2 rounded-md border bg-card p-3"
								data-testid="recovery-prepared-file"
							>
								<p className="font-medium text-sm">
									{item.classification === "complete"
										? m.replica_recovery_complete()
										: item.classification === "partial"
											? m.replica_recovery_partial()
											: m.replica_recovery_retained_unknown()}
								</p>
								<p className="text-muted-foreground text-sm">
									{item.downloadRequested
										? m.replica_recovery_download_requested()
										: item.classification === "unknown"
											? null
											: m.replica_recovery_prepared()}
								</p>
								<div className="flex flex-wrap gap-2">
									<Button variant="outline" onClick={() => download(item)}>
										{m.replica_recovery_download()}
									</Button>
									<Button
										variant="outline"
										disabled={busy}
										onClick={() => void release(item)}
									>
										{m.replica_recovery_release()}
									</Button>
								</div>
								<p className="text-muted-foreground text-xs">
									{m.replica_recovery_release_description()}
								</p>
							</section>
						))}
					</div>
				</DialogContent>
			</Dialog>
		</RecoveryEntryContext.Provider>
	);
}
