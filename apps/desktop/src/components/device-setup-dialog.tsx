import {
	buildDeviceSetupLinkUri,
	buildDeviceSetupQrUri,
} from "@bittery/shared/device-setup";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import {
	cn,
	copyWithToast,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@bittery/ui";
import { IconCopy, IconLoaderCircle } from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useMemo, useState } from "react";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

interface DeviceSetupAccount {
	accountId: string;
	email: string;
	name: string;
	teamName?: string;
	serverUrl?: string;
}

interface DeviceSetupDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accounts: DeviceSetupAccount[];
	initialAccountId?: string | null;
}

type SetupPreviewErrorKey =
	| "vaults_sidebar_account_switcher_device_setup_dialog_error_select_account"
	| "vaults_sidebar_account_switcher_device_setup_dialog_error_no_server_url"
	| "vaults_sidebar_account_switcher_device_setup_dialog_error_no_secret_key"
	| "vaults_sidebar_account_switcher_device_setup_dialog_error_generate_failed";

export function DeviceSetupDialog({
	open,
	onOpenChange,
	accounts,
	initialAccountId,
}: DeviceSetupDialogProps) {
	const initialSelectedAccountId =
		(initialAccountId
			? accounts.find((account) => account.accountId === initialAccountId)
					?.accountId
			: undefined) ??
		accounts[0]?.accountId ??
		"";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? (
				<DeviceSetupDialogContent
					key={`${open ? "open" : "closed"}:${initialSelectedAccountId}`}
					accounts={accounts}
					initialSelectedAccountId={initialSelectedAccountId}
				/>
			) : null}
		</Dialog>
	);
}

function DeviceSetupDialogContent({
	accounts,
	initialSelectedAccountId,
}: Pick<DeviceSetupDialogProps, "accounts"> & {
	initialSelectedAccountId: string;
}) {
	const { m } = useI18n();
	const fallbackServerUrl =
		normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ?? null;
	const [selectedAccountId, setSelectedAccountId] = useState(
		initialSelectedAccountId,
	);

	const selectedAccount = useMemo(
		() =>
			accounts.find((account) => account.accountId === selectedAccountId) ??
			null,
		[accounts, selectedAccountId],
	);

	const setupDataQuery = useQuery({
		queryKey: ["device-setup", selectedAccountId],
		enabled: !!selectedAccountId,
		queryFn: async () => {
			const [storedServerUrl, secretKey] = await Promise.all([
				storage.getServerUrl(selectedAccountId),
				storage.getStoredSecretKey(selectedAccountId),
			]);

			const serverUrl =
				normalizeServerUrl(storedServerUrl) ??
				normalizeServerUrl(selectedAccount?.serverUrl) ??
				fallbackServerUrl;

			return {
				serverUrl,
				secretKey,
			};
		},
	});

	const setupPreview = useMemo(() => {
		if (!selectedAccount) {
			return {
				linkUri: null,
				qrUri: null,
				errorKey:
					"vaults_sidebar_account_switcher_device_setup_dialog_error_select_account" as SetupPreviewErrorKey,
			};
		}

		if (!setupDataQuery.data?.serverUrl) {
			return {
				linkUri: null,
				qrUri: null,
				errorKey:
					"vaults_sidebar_account_switcher_device_setup_dialog_error_no_server_url" as SetupPreviewErrorKey,
			};
		}

		try {
			const basePayload = {
				email: selectedAccount.email,
				serverUrl: setupDataQuery.data.serverUrl,
				teamName: selectedAccount.teamName || selectedAccount.name,
			};
			const linkUri = buildDeviceSetupLinkUri(basePayload);

			if (!setupDataQuery.data.secretKey) {
				return {
					linkUri,
					qrUri: null,
					errorKey:
						"vaults_sidebar_account_switcher_device_setup_dialog_error_no_secret_key" as SetupPreviewErrorKey,
				};
			}

			const qrUri = buildDeviceSetupQrUri({
				...basePayload,
				secretKey: setupDataQuery.data.secretKey,
			});

			return {
				linkUri,
				qrUri,
				errorKey: null,
			};
		} catch {
			return {
				linkUri: null,
				qrUri: null,
				errorKey:
					"vaults_sidebar_account_switcher_device_setup_dialog_error_generate_failed" as SetupPreviewErrorKey,
			};
		}
	}, [selectedAccount, setupDataQuery.data]);

	const setupPreviewError = useMemo(() => {
		switch (setupPreview.errorKey) {
			case "vaults_sidebar_account_switcher_device_setup_dialog_error_select_account":
				return m.vaults_sidebar_account_switcher_device_setup_dialog_error_select_account();
			case "vaults_sidebar_account_switcher_device_setup_dialog_error_no_server_url":
				return m.vaults_sidebar_account_switcher_device_setup_dialog_error_no_server_url();
			case "vaults_sidebar_account_switcher_device_setup_dialog_error_no_secret_key":
				return m.vaults_sidebar_account_switcher_device_setup_dialog_error_no_secret_key();
			case "vaults_sidebar_account_switcher_device_setup_dialog_error_generate_failed":
				return m.vaults_sidebar_account_switcher_device_setup_dialog_error_generate_failed();
			default:
				return null;
		}
	}, [m, setupPreview.errorKey]);

	const handleCopyLink = async () => {
		await copyWithToast(setupPreview.linkUri, m.sharing_common_link_label(), {
			autoClearMs: 0,
			showAutoClearMessage: false,
		});
	};

	const steps = [
		m.vaults_sidebar_account_switcher_device_setup_dialog_step_1(),
		m.vaults_sidebar_account_switcher_device_setup_dialog_step_2(),
		m.vaults_sidebar_account_switcher_device_setup_dialog_step_3(),
		m.vaults_sidebar_account_switcher_device_setup_dialog_step_4(),
		m.vaults_sidebar_account_switcher_device_setup_dialog_step_5(),
	];

	return (
		<DialogContent className="gap-0 p-0 sm:max-w-xl">
			<DialogHeader className="relative gap-1 px-5 pt-5 pb-4 text-left">
				<DialogTitle>
					{m.vaults_sidebar_account_switcher_menu_setup_another_device()}
				</DialogTitle>
				<DialogDescription>
					{m.vaults_sidebar_account_switcher_device_setup_dialog_description()}
				</DialogDescription>
			</DialogHeader>

			{/* min-w-0: the mono setup link is one unbreakable string — without this
			    the grid child grows to its min-content width and blows out the dialog */}
			<div className="flex min-w-0 flex-col gap-4 px-5 pb-5">
				{accounts.length > 1 && (
					<div className="grid gap-1.5">
						<Label htmlFor="device-setup-account">
							{m.vaults_sidebar_account_switcher_device_setup_dialog_field_account()}
						</Label>
						<Select
							value={selectedAccountId}
							onValueChange={setSelectedAccountId}
						>
							<SelectTrigger id="device-setup-account">
								<SelectValue
									placeholder={m.vaults_sidebar_account_switcher_device_setup_dialog_placeholder_select_account()}
								/>
							</SelectTrigger>
							<SelectContent>
								{accounts.map((account) => (
									<SelectItem key={account.accountId} value={account.accountId}>
										{account.teamName || account.name || account.email}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}

				{/* QR + steps panel */}
				<div className="grid min-h-[232px] place-items-center rounded-lg border bg-card p-5">
					{setupDataQuery.isLoading ? (
						<IconLoaderCircle className="size-5 animate-spin text-muted-foreground" />
					) : setupPreview.qrUri ? (
						<div className="flex w-full items-center gap-6">
							<div className="shrink-0 rounded-lg bg-white p-3 shadow-[0_2px_8px_oklch(0_0_0/0.15),0_0_24px_color-mix(in_oklab,var(--color-primary-deep)_18%,transparent)]">
								<QRCodeSVG value={setupPreview.qrUri} size={168} level="M" />
							</div>
							<ol className="flex min-w-0 flex-1 flex-col gap-3">
								{steps.map((step, index) => (
									<li
										key={step}
										className="flex items-start gap-2.5 text-muted-foreground text-xs leading-snug"
									>
										<span
											aria-hidden
											className="mt-px grid size-4 shrink-0 place-items-center rounded-full border bg-foreground/3 text-[10px] tabular-nums"
										>
											{index + 1}
										</span>
										{step}
									</li>
								))}
							</ol>
						</div>
					) : (
						<p className="max-w-[40ch] text-center text-muted-foreground text-sm">
							{setupPreview.errorKey ===
							"vaults_sidebar_account_switcher_device_setup_dialog_error_no_secret_key"
								? m.vaults_sidebar_account_switcher_device_setup_dialog_no_secret_key_guidance()
								: setupPreviewError}
						</p>
					)}
				</div>

				{/* Setup link field row */}
				<div className="group/link flex min-h-[46px] items-center gap-3 rounded-lg border bg-card px-4 py-2">
					<div className="min-w-0 flex-1">
						<div className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.05em]">
							{m.vaults_sidebar_account_switcher_device_setup_dialog_field_setup_link()}
						</div>
						<div
							className={cn(
								"truncate font-mono text-[11.5px]",
								!setupPreview.linkUri && "text-muted-foreground",
							)}
							title={setupPreview.linkUri ?? undefined}
						>
							{setupPreview.linkUri ??
								m.vaults_sidebar_account_switcher_device_setup_dialog_placeholder_link_unavailable()}
						</div>
					</div>
					{setupPreview.linkUri && (
						<button
							type="button"
							onClick={handleCopyLink}
							aria-label={m.vaults_sidebar_account_switcher_action_copy()}
							className="grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-overlay hover:text-foreground focus-visible:opacity-100 group-hover/link:opacity-100"
						>
							<IconCopy className="size-3.5" />
						</button>
					)}
				</div>
			</div>
		</DialogContent>
	);
}
