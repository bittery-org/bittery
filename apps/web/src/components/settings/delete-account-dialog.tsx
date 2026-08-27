import { useRuntimeClient } from "@bittery/client-runtime/react";
import { useApiClient } from "@bittery/shared/api";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
	Button,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import { IconTrash as Trash2 } from "@bittery/ui/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
	type AccountDeletionDeps,
	type AccountDeletionIncomplete,
	deleteAccountEverywhereFromDevice,
	retryCannotFinish,
} from "@/lib/account-removal";
import {
	clearActiveAccountData,
	forgetWebAccountId,
	getTransitionalAccountId,
	readDeletedServerAccountId,
	writeDeletedServerAccountId,
} from "@/lib/storage";
import { getTeardownAreaLabel } from "@/lib/teardown-areas";
import { useAccountRuntime } from "@/providers/account-runtime-provider";
import { useI18n } from "@/providers/i18n-provider";

/** Confirming the deletion, running it, or reporting what it could not finish. */
type DeletionState =
	| { readonly phase: "confirming" }
	| {
			readonly phase: "deleting";
			readonly previous: AccountDeletionIncomplete | null;
	  }
	| {
			readonly phase: "incomplete";
			readonly result: AccountDeletionIncomplete;
	  };

const CONFIRMING: DeletionState = { phase: "confirming" };

export function DeleteAccountDialog({ userEmail }: { userEmail: string }) {
	const { m } = useI18n();
	const { manager } = useAccountRuntime();
	const runtimeClient = useRuntimeClient();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [confirmEmail, setConfirmEmail] = useState("");
	const [confirmText, setConfirmText] = useState("");
	const [deletion, setDeletion] = useState<DeletionState>(CONFIRMING);
	const apiClient = useApiClient();
	const navigate = useNavigate();
	const confirmPhrase = m.settings_delete_account_dialog_confirm_phrase();

	// The report outlives the dialog, and carries both Account names for the reason
	// `account-removal.ts` gives. It does not outlive the page: once the Server has let
	// go, the next request answers 401 and `router.tsx` replaces this document. So the one
	// fact nothing can re-derive is written down as well, by the deps below.
	const lastIncompleteReport = useRef<AccountDeletionIncomplete | null>(null);

	// The Server first, then the Runtime. That ordering is this screen's own: the Runtime
	// knows nothing about a Server Account, and destroying the local copy of an Account the
	// Server still holds locks the user out of an Account that still exists. Everything
	// after the Server is ordinary Account removal, so it is the same composition the
	// sidebar's "Log out" uses.
	const deletionDeps = (email: string): AccountDeletionDeps => ({
		deleteServerAccount: async () => {
			await apiClient.auth.deleteAccount({ confirmEmail: email });
		},
		resolveRuntimeAccountId: () => runtimeClient.resolveAccount(),
		resolveTransitionalAccountId: getTransitionalAccountId,
		removeAccount: (accountId: string) =>
			runtimeClient.removeAccount(accountId),
		selectAccount: (accountId: string | null) =>
			runtimeClient.selectAccount(accountId),
		clearTransitionalAccountData: (accountId: string) =>
			clearActiveAccountData(accountId, () => manager.refresh()),
		forgetTransitionalAccountId: forgetWebAccountId,
		readDeletedServerAccountId,
		writeDeletedServerAccountId,
	});

	const runDeletion = async (previous: AccountDeletionIncomplete | null) => {
		setDeletion({ phase: "deleting", previous });
		const result = await deleteAccountEverywhereFromDevice(
			previous,
			deletionDeps(confirmEmail),
		);
		if (result.status === "deleted") {
			lastIncompleteReport.current = null;
			setDeletion(CONFIRMING);
			setOpen(false);
			toast.success(m.settings_delete_account_dialog_toast_deleted());
			try {
				// The cache holds decrypted Items for an Account that no longer exists.
				queryClient.clear();
				await navigate({ to: "/" });
			} catch {
				window.location.assign("/");
			}
			return;
		}
		// Never a success toast and never a navigation: the Server, the Runtime or this
		// browser still holds something the user asked to be gone.
		lastIncompleteReport.current = result;
		setDeletion({ phase: "incomplete", result });
		toast.error(m.settings_delete_account_dialog_toast_delete_failed());
	};

	const report =
		deletion.phase === "incomplete"
			? deletion.result
			: deletion.phase === "deleting"
				? deletion.previous
				: null;
	const busy = deletion.phase === "deleting";
	// An empty transitional pointer is refused on every attempt for the rest of this page
	// load, so this dialog offers no retry there. A button that cannot work is worse than
	// no button: it asks the user to keep pressing a promise nothing can keep.
	const stranded = report !== null && retryCannotFinish(report);
	// The typed email is what the Server checks, so the confirmation stands until the
	// Server has let go. After that the remaining work is local and already authorised.
	const needsConfirmation =
		!stranded && (report === null || !report.serverAccountDeleted);
	const confirmed =
		confirmEmail.toLowerCase() === userEmail.toLowerCase() &&
		confirmText === confirmPhrase;

	const handleDelete = () => {
		if (needsConfirmation) {
			if (confirmEmail.toLowerCase() !== userEmail.toLowerCase()) {
				toast.error(m.settings_delete_account_dialog_toast_email_mismatch());
				return;
			}
			if (confirmText !== confirmPhrase) {
				toast.error(
					m.settings_delete_account_dialog_toast_confirm_phrase_required(),
				);
				return;
			}
		}
		void runDeletion(report);
	};

	const handleOpenChange = (newOpen: boolean) => {
		if (busy) {
			return;
		}
		setOpen(newOpen);
		if (newOpen) {
			// Reopening shows the held report rather than a fresh confirmation, so a
			// second attempt reuses the names and the Server step the first one settled.
			setDeletion(
				lastIncompleteReport.current === null
					? CONFIRMING
					: { phase: "incomplete", result: lastIncompleteReport.current },
			);
			return;
		}
		setConfirmEmail("");
		setConfirmText("");
	};

	return (
		<AlertDialog open={open} onOpenChange={handleOpenChange}>
			<AlertDialogTrigger asChild>
				<Button variant="destructive">
					<Trash2 className="mr-2 h-4 w-4" />
					{m.settings_delete_account_dialog_trigger()}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent
				data-testid="delete-account-dialog"
				onEscapeKeyDown={(event) => {
					if (busy) event.preventDefault();
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{report
							? m.settings_delete_account_dialog_incomplete_title()
							: m.settings_delete_account_dialog_title()}
					</AlertDialogTitle>
					<AlertDialogDescription asChild>
						{report ? (
							<p>
								{stranded
									? report.serverAccountDeleted
										? m.settings_delete_account_dialog_stranded_local()
										: m.settings_delete_account_dialog_stranded_server()
									: report.serverAccountDeleted
										? m.settings_delete_account_dialog_incomplete_local()
										: m.settings_delete_account_dialog_incomplete_server()}
							</p>
						) : (
							<div className="space-y-3">
								<p>
									{m.settings_delete_account_dialog_description_prefix()}{" "}
									<strong>
										{m.settings_delete_account_dialog_description_permanent()}
									</strong>
									. {m.settings_delete_account_dialog_description_suffix()}
								</p>
								<ul className="list-inside list-disc space-y-1 text-sm">
									<li>
										{m.settings_delete_account_dialog_list_remove_vaults()}
									</li>
									<li>
										{m.settings_delete_account_dialog_list_remove_teams()}
									</li>
									<li>
										{m.settings_delete_account_dialog_list_delete_sessions()}
									</li>
									<li>
										{m.settings_delete_account_dialog_list_erase_account()}
									</li>
								</ul>
							</div>
						)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{report && report.areas.length > 0 ? (
					<ul
						className="list-disc space-y-1 pl-5 text-muted-foreground text-sm"
						data-testid="delete-account-incomplete-areas"
					>
						{report.areas.map((area) => (
							<li key={area}>{getTeardownAreaLabel(area, m)}</li>
						))}
					</ul>
				) : null}
				{needsConfirmation ? (
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="confirmEmail">
								{m.settings_delete_account_dialog_field_email_label()}{" "}
								<span className="font-mono text-muted-foreground">
									{userEmail}
								</span>
							</Label>
							<Input
								id="confirmEmail"
								type="email"
								value={confirmEmail}
								onChange={(e) => setConfirmEmail(e.target.value)}
								placeholder={m.settings_delete_account_dialog_placeholder_email()}
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="confirmText">
								{m.settings_delete_account_dialog_field_confirm_phrase_label()}{" "}
								<span className="font-mono font-semibold">{confirmPhrase}</span>{" "}
								{m.settings_delete_account_dialog_field_confirm_phrase_suffix()}
							</Label>
							<Input
								id="confirmText"
								value={confirmText}
								onChange={(e) => setConfirmText(e.target.value)}
								placeholder={confirmPhrase}
							/>
						</div>
					</div>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel
						disabled={busy}
						data-testid="delete-account-cancel"
					>
						{report
							? m.settings_delete_account_dialog_incomplete_close()
							: m.settings_common_action_cancel()}
					</AlertDialogCancel>
					{stranded ? null : (
						<Button
							variant="destructive"
							onClick={handleDelete}
							disabled={busy || (needsConfirmation && !confirmed)}
							data-testid="delete-account-confirm"
						>
							{busy
								? m.settings_delete_account_dialog_action_deleting()
								: report
									? m.settings_delete_account_dialog_incomplete_retry()
									: m.settings_delete_account_dialog_action_submit()}
						</Button>
					)}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
