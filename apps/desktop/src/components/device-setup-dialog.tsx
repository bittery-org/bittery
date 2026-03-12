import {
	buildDeviceSetupLinkUri,
	buildDeviceSetupQrUri,
	normalizeServerUrl,
} from "@bittery/shared";
import {
	Button,
	copyWithToast,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@bittery/ui";
import {
	IconCopyOutlineDuo18,
	IconLoader2OutlineDuo18,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useMemo, useState } from "react";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

interface DeviceSetupAccount {
	email: string;
	name: string;
	teamName?: string;
}

interface DeviceSetupDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accounts: DeviceSetupAccount[];
	initialAccountEmail?: string | null;
}

type SetupPreviewErrorKey =
	| "vaults.sidebar.account_switcher.device_setup_dialog.error.select_account"
	| "vaults.sidebar.account_switcher.device_setup_dialog.error.no_server_url"
	| "vaults.sidebar.account_switcher.device_setup_dialog.error.no_secret_key"
	| "vaults.sidebar.account_switcher.device_setup_dialog.error.generate_failed";

export function DeviceSetupDialog({
	open,
	onOpenChange,
	accounts,
	initialAccountEmail,
}: DeviceSetupDialogProps) {
	const initialSelectedEmail =
		accounts.find(
			(account) =>
				initialAccountEmail &&
				account.email.toLowerCase() === initialAccountEmail.toLowerCase(),
		)?.email ??
		accounts[0]?.email ??
		"";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? (
				<DeviceSetupDialogContent
					key={`${open ? "open" : "closed"}:${initialSelectedEmail}`}
					accounts={accounts}
					initialSelectedEmail={initialSelectedEmail}
					onOpenChange={onOpenChange}
				/>
			) : null}
		</Dialog>
	);
}

function DeviceSetupDialogContent({
	accounts,
	initialSelectedEmail,
	onOpenChange,
}: Pick<DeviceSetupDialogProps, "accounts" | "onOpenChange"> & {
	initialSelectedEmail: string;
}) {
	const { m } = useI18n();
	const fallbackServerUrl =
		normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ?? null;
	const [selectedEmail, setSelectedEmail] = useState(initialSelectedEmail);

	const selectedAccount = useMemo(
		() =>
			accounts.find(
				(account) =>
					account.email.toLowerCase() === selectedEmail.toLowerCase(),
			) ?? null,
		[accounts, selectedEmail],
	);

	const setupDataQuery = useQuery({
		queryKey: ["device-setup", selectedEmail],
		enabled: !!selectedEmail,
		queryFn: async () => {
			const [storedServerUrl, legacyServerUrl, secretKey] = await Promise.all([
				storage.getServerUrl(selectedEmail),
				storage.getLegacyServerUrl(),
				storage.getStoredSecretKey(selectedEmail),
			]);

			const serverUrl =
				normalizeServerUrl(storedServerUrl) ??
				normalizeServerUrl(legacyServerUrl) ??
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
					"vaults.sidebar.account_switcher.device_setup_dialog.error.select_account" as SetupPreviewErrorKey,
			};
		}

		if (!setupDataQuery.data?.serverUrl) {
			return {
				linkUri: null,
				qrUri: null,
				errorKey:
					"vaults.sidebar.account_switcher.device_setup_dialog.error.no_server_url" as SetupPreviewErrorKey,
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
						"vaults.sidebar.account_switcher.device_setup_dialog.error.no_secret_key" as SetupPreviewErrorKey,
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
					"vaults.sidebar.account_switcher.device_setup_dialog.error.generate_failed" as SetupPreviewErrorKey,
			};
		}
	}, [selectedAccount, setupDataQuery.data]);

	const setupPreviewError = useMemo(() => {
		switch (setupPreview.errorKey) {
			case "vaults.sidebar.account_switcher.device_setup_dialog.error.select_account":
				return m[
					"vaults.sidebar.account_switcher.device_setup_dialog.error.select_account"
				]();
			case "vaults.sidebar.account_switcher.device_setup_dialog.error.no_server_url":
				return m[
					"vaults.sidebar.account_switcher.device_setup_dialog.error.no_server_url"
				]();
			case "vaults.sidebar.account_switcher.device_setup_dialog.error.no_secret_key":
				return m[
					"vaults.sidebar.account_switcher.device_setup_dialog.error.no_secret_key"
				]();
			case "vaults.sidebar.account_switcher.device_setup_dialog.error.generate_failed":
				return m[
					"vaults.sidebar.account_switcher.device_setup_dialog.error.generate_failed"
				]();
			default:
				return null;
		}
	}, [m, setupPreview.errorKey]);

	const handleCopyLink = async () => {
		await copyWithToast(
			setupPreview.linkUri,
			m["sharing.common.link_label"](),
			{
				autoClearMs: 0,
				showAutoClearMessage: false,
			},
		);
	};

	return (
		<DialogContent className="sm:max-w-md">
			<DialogHeader>
				<DialogTitle>
					{m["vaults.sidebar.account_switcher.menu.setup_another_device"]()}
				</DialogTitle>
				<DialogDescription>
					{m[
						"vaults.sidebar.account_switcher.device_setup_dialog.description"
					]()}
				</DialogDescription>
			</DialogHeader>

			<div className="space-y-3">
				<div className="space-y-1.5">
					<Label htmlFor="device-setup-account" className="text-xs">
						{m[
							"vaults.sidebar.account_switcher.device_setup_dialog.field.account"
						]()}
					</Label>
					<Select value={selectedEmail} onValueChange={setSelectedEmail}>
						<SelectTrigger id="device-setup-account">
							<SelectValue
								placeholder={m[
									"vaults.sidebar.account_switcher.device_setup_dialog.placeholder.select_account"
								]()}
							/>
						</SelectTrigger>
						<SelectContent>
							{accounts.map((account) => (
								<SelectItem key={account.email} value={account.email}>
									{account.teamName || account.name || account.email}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="flex min-h-64 items-center justify-center rounded-md bg-muted/20 p-4">
					{setupDataQuery.isLoading ? (
						<IconLoader2OutlineDuo18 className="h-5 w-5 animate-spin text-muted-foreground" />
					) : setupPreview.qrUri ? (
						<div className="rounded-md bg-white p-2.5">
							<QRCodeSVG
								value={setupPreview.qrUri}
								size={208}
								includeMargin={true}
								level="M"
							/>
						</div>
					) : (
						<p className="text-center text-muted-foreground text-sm">
							{setupPreviewError}
						</p>
					)}
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="device-setup-link" className="text-xs">
						{m[
							"vaults.sidebar.account_switcher.device_setup_dialog.field.setup_link"
						]()}
					</Label>
					<div className="flex gap-2">
						<Input
							id="device-setup-link"
							value={setupPreview.linkUri ?? ""}
							readOnly
							placeholder={m[
								"vaults.sidebar.account_switcher.device_setup_dialog.placeholder.link_unavailable"
							]()}
							className="font-mono text-[11px]"
						/>
						<Button
							type="button"
							variant="outline"
							onClick={handleCopyLink}
							disabled={!setupPreview.linkUri}
						>
							<IconCopyOutlineDuo18 className="h-4 w-4" />
						</Button>
					</div>
				</div>
			</div>

			<DialogFooter>
				<Button variant="outline" onClick={() => onOpenChange(false)}>
					{m[
						"vaults.sidebar.account_switcher.device_setup_dialog.action.close"
					]()}
				</Button>
			</DialogFooter>
		</DialogContent>
	);
}
