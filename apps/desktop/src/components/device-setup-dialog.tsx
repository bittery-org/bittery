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
import { useEffect, useMemo, useState } from "react";
import { storage } from "@/lib/storage";

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

export function DeviceSetupDialog({
	open,
	onOpenChange,
	accounts,
	initialAccountEmail,
}: DeviceSetupDialogProps) {
	const fallbackServerUrl =
		normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ?? null;
	const [selectedEmail, setSelectedEmail] = useState("");

	useEffect(() => {
		if (!open) return;

		const nextAccount =
			accounts.find(
				(account) =>
					initialAccountEmail &&
					account.email.toLowerCase() === initialAccountEmail.toLowerCase(),
			) ?? accounts[0];

		setSelectedEmail(nextAccount?.email ?? "");
	}, [accounts, initialAccountEmail, open]);

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
		enabled: open && !!selectedEmail,
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
				error: "Select an account to generate setup details.",
			};
		}

		if (!setupDataQuery.data?.serverUrl) {
			return {
				linkUri: null,
				qrUri: null,
				error: "No server URL found for this account.",
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
					error: "No secret key is stored for this account.",
				};
			}

			const qrUri = buildDeviceSetupQrUri({
				...basePayload,
				secretKey: setupDataQuery.data.secretKey,
			});

			return {
				linkUri,
				qrUri,
				error: null,
			};
		} catch (error) {
			return {
				linkUri: null,
				qrUri: null,
				error:
					error instanceof Error
						? error.message
						: "Unable to generate setup details.",
			};
		}
	}, [selectedAccount, setupDataQuery.data]);

	const handleCopyLink = async () => {
		await copyWithToast(setupPreview.linkUri, "Link", {
			autoClearMs: 0,
			showAutoClearMessage: false,
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Set up another device</DialogTitle>
					<DialogDescription>
						Select an account and scan the QR code in mobile sign in.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="device-setup-account" className="text-xs">
							Account
						</Label>
						<Select value={selectedEmail} onValueChange={setSelectedEmail}>
							<SelectTrigger id="device-setup-account">
								<SelectValue placeholder="Select an account" />
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
								{setupPreview.error}
							</p>
						)}
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="device-setup-link" className="text-xs">
							Setup link
						</Label>
						<div className="flex gap-2">
							<Input
								id="device-setup-link"
								value={setupPreview.linkUri ?? ""}
								readOnly
								placeholder="Link unavailable for this account"
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
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
