import {
	buildDeviceSetupLinkUri,
	buildDeviceSetupQrUri,
} from "@bittery/shared";
import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
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
} from "@bittery/ui";
import { IconCopy, IconLoaderCircle } from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useMemo } from "react";
import { getServerUrl } from "@/lib/auth-server";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

interface WebDeviceSetupDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function WebDeviceSetupDialog({
	open,
	onOpenChange,
}: WebDeviceSetupDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? (
				<WebDeviceSetupDialogContent onOpenChange={onOpenChange} />
			) : null}
		</Dialog>
	);
}

function WebDeviceSetupDialogContent({
	onOpenChange,
}: Pick<WebDeviceSetupDialogProps, "onOpenChange">) {
	const { m } = useI18n();
	const api = useApiClient();
	const serverUrl = getServerUrl();

	const meQuery = useQuery(apiQueries.auth.me(api));
	const email = meQuery.data?.email ?? "";
	const teamName = meQuery.data?.teamName ?? meQuery.data?.name ?? "";

	const setupDataQuery = useQuery({
		queryKey: ["web-device-setup", email],
		enabled: !!email,
		queryFn: async () => {
			const secretKey = await storage.getStoredSecretKey();
			return { secretKey };
		},
	});

	const setupPreview = useMemo(() => {
		if (!email || !serverUrl) {
			return { linkUri: null, qrUri: null, hasSecretKey: false };
		}

		try {
			const basePayload = { email, serverUrl, teamName };
			const linkUri = buildDeviceSetupLinkUri(basePayload);

			if (!setupDataQuery.data?.secretKey) {
				return { linkUri, qrUri: null, hasSecretKey: false };
			}

			const qrUri = buildDeviceSetupQrUri({
				...basePayload,
				secretKey: setupDataQuery.data.secretKey,
			});

			return { linkUri, qrUri, hasSecretKey: true };
		} catch {
			return { linkUri: null, qrUri: null, hasSecretKey: false };
		}
	}, [email, serverUrl, teamName, setupDataQuery.data]);

	const handleCopyLink = async () => {
		await copyWithToast(setupPreview.linkUri, m.sharing_common_link_label(), {
			autoClearMs: 0,
			showAutoClearMessage: false,
		});
	};

	const isLoading = meQuery.isLoading || setupDataQuery.isLoading;

	return (
		<DialogContent className="sm:max-w-md">
			<DialogHeader>
				<DialogTitle>{m.settings_devices_action_setup_another()}</DialogTitle>
				<DialogDescription>
					{m.vaults_sidebar_account_switcher_device_setup_dialog_description()}
				</DialogDescription>
			</DialogHeader>

			<div className="space-y-3">
				<div className="flex min-h-64 items-center justify-center rounded-md bg-muted/20 p-4">
					{isLoading ? (
						<IconLoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" />
					) : setupPreview.qrUri ? (
						<div className="flex flex-col items-center gap-4">
							<div className="rounded-md bg-white p-2.5">
								<QRCodeSVG
									value={setupPreview.qrUri}
									size={208}
									includeMargin={true}
									level="M"
								/>
							</div>
							<ol className="space-y-1 text-left text-muted-foreground text-xs">
								<li>
									1.{" "}
									{m.vaults_sidebar_account_switcher_device_setup_dialog_step_1()}
								</li>
								<li>
									2.{" "}
									{m.vaults_sidebar_account_switcher_device_setup_dialog_step_2()}
								</li>
								<li>
									3.{" "}
									{m.vaults_sidebar_account_switcher_device_setup_dialog_step_3()}
								</li>
								<li>
									4.{" "}
									{m.vaults_sidebar_account_switcher_device_setup_dialog_step_4()}
								</li>
								<li>
									5.{" "}
									{m.vaults_sidebar_account_switcher_device_setup_dialog_step_5()}
								</li>
							</ol>
						</div>
					) : (
						<p className="text-center text-muted-foreground text-sm">
							{!setupPreview.hasSecretKey && setupPreview.linkUri
								? m.vaults_sidebar_account_switcher_device_setup_dialog_no_secret_key_guidance()
								: m.vaults_sidebar_account_switcher_device_setup_dialog_error_generate_failed()}
						</p>
					)}
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="web-device-setup-link" className="text-xs">
						{m.vaults_sidebar_account_switcher_device_setup_dialog_field_setup_link()}
					</Label>
					<div className="flex gap-2">
						<Input
							id="web-device-setup-link"
							value={setupPreview.linkUri ?? ""}
							readOnly
							placeholder={m.vaults_sidebar_account_switcher_device_setup_dialog_placeholder_link_unavailable()}
							className="font-mono text-[11px]"
						/>
						<Button
							type="button"
							variant="outline"
							onClick={handleCopyLink}
							disabled={!setupPreview.linkUri}
						>
							<IconCopy className="h-4 w-4" />
						</Button>
					</div>
				</div>
			</div>

			<DialogFooter>
				<Button variant="outline" onClick={() => onOpenChange(false)}>
					{m.vaults_sidebar_account_switcher_device_setup_dialog_action_close()}
				</Button>
			</DialogFooter>
		</DialogContent>
	);
}
