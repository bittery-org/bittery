import { usePlatformCrypto } from "@bittery/core/hooks";
import {
	changeAccountPassword,
	InvalidAccountPasswordError,
	LocalKeyAdoptionError,
} from "@bittery/core/services/vault-crypto";
import { useRPC, useRPCClient } from "@bittery/shared/rpc";
import { toVaultKeyEntry } from "@bittery/shared/vault-mapping";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import {
	IconEye as Eye,
	IconEyeOff as EyeOff,
	IconKey as Key,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

export function ChangePasswordDialog({ userEmail }: { userEmail: string }) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [showCurrentPassword, setShowCurrentPassword] = useState(false);
	const [showNewPassword, setShowNewPassword] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);
	const rpcClient = useRPCClient();
	const rpc = useRPC();
	const crypto = usePlatformCrypto();
	const navigate = useNavigate();

	const userQuery = useQuery(rpc.auth.me.queryOptions());
	const vaultListQuery = useQuery(rpc.vault.list.queryOptions());

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!currentPassword.trim()) {
			toast.error(
				m.settings_change_password_dialog_toast_current_password_required(),
			);
			return;
		}
		if (!newPassword.trim()) {
			toast.error(
				m.settings_change_password_dialog_toast_new_password_required(),
			);
			return;
		}
		if (newPassword.length < 8) {
			toast.error(
				m.settings_change_password_dialog_toast_password_min_length(),
			);
			return;
		}
		if (newPassword !== confirmPassword) {
			toast.error(m.settings_change_password_dialog_toast_password_mismatch());
			return;
		}

		const secretKey = await storage.getStoredSecretKey();
		if (!secretKey) {
			toast.error(m.settings_common_toast_secret_key_not_found());
			return;
		}

		const accountId = await storage.getActiveAccount();
		if (!accountId || !userQuery.data?.encryptedPrivateKey) {
			toast.error(m.settings_common_toast_user_data_load_failed());
			return;
		}

		if (!vaultListQuery.data || vaultListQuery.data.length === 0) {
			toast.error(m.settings_common_toast_vault_keys_load_failed());
			return;
		}

		setIsProcessing(true);

		try {
			await changeAccountPassword(
				{
					accountId,
					email: userEmail,
					userId: userQuery.data.id,
					currentPassword,
					newPassword,
					secretKey,
					encryptedPrivateKey: userQuery.data.encryptedPrivateKey,
					vaultKeys: vaultListQuery.data.map(toVaultKeyEntry),
				},
				{
					crypto,
					storage,
					commit: (payload) => rpcClient.auth.changePassword.mutate(payload),
				},
			);

			toast.success(m.settings_change_password_dialog_toast_changed());
			setOpen(false);
			navigate({ to: "/login" });
		} catch (error) {
			// The server has already accepted the new password, so telling the user to try
			// again would send them back with credentials that no longer exist.
			if (error instanceof LocalKeyAdoptionError) {
				toast.warning(m.settings_common_toast_keys_changed_sign_in_again());
				setOpen(false);
				navigate({ to: "/login" });
				return;
			}
			if (error instanceof InvalidAccountPasswordError) {
				toast.error(m.settings_common_toast_current_password_invalid());
				setIsProcessing(false);
				return;
			}
			console.error("Password change error:", error);
			toast.error(m.settings_change_password_dialog_toast_change_failed());
			setIsProcessing(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Key className="mr-2 h-4 w-4" />
					{m.settings_change_password_dialog_trigger()}
				</Button>
			</DialogTrigger>
			<DialogContent data-testid="change-password-dialog">
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>
							{m.settings_change_password_dialog_title()}
						</DialogTitle>
						<DialogDescription>
							{m.settings_change_password_dialog_description()}
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="currentPassword">
								{m.settings_change_password_dialog_field_current_password()}
							</Label>
							<div className="relative">
								<Input
									id="currentPassword"
									type={showCurrentPassword ? "text" : "password"}
									value={currentPassword}
									onChange={(e) => setCurrentPassword(e.target.value)}
									placeholder={m.settings_change_password_dialog_placeholder_current_password()}
									autoFocus
									className="pr-10"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="absolute top-0 right-0 h-full w-10 text-muted-foreground hover:text-foreground"
									onClick={() => setShowCurrentPassword(!showCurrentPassword)}
								>
									{showCurrentPassword ? (
										<EyeOff size={16} />
									) : (
										<Eye size={16} />
									)}
								</Button>
							</div>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="newPassword">
								{m.settings_change_password_dialog_field_new_password()}
							</Label>
							<div className="relative">
								<Input
									id="newPassword"
									type={showNewPassword ? "text" : "password"}
									value={newPassword}
									onChange={(e) => setNewPassword(e.target.value)}
									placeholder={m.settings_change_password_dialog_placeholder_new_password()}
									className="pr-10"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="absolute top-0 right-0 h-full w-10 text-muted-foreground hover:text-foreground"
									onClick={() => setShowNewPassword(!showNewPassword)}
								>
									{showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
								</Button>
							</div>
							<p className="text-muted-foreground text-xs">
								{m.settings_change_password_dialog_hint_password_min_length()}
							</p>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="confirmPassword">
								{m.settings_change_password_dialog_field_confirm_new_password()}
							</Label>
							<Input
								id="confirmPassword"
								type="password"
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
								placeholder={m.settings_change_password_dialog_placeholder_confirm_new_password()}
							/>
						</div>
					</div>
					<div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
						<p className="text-amber-700 text-xs dark:text-amber-300">
							<strong>{m.settings_common_warning()}</strong>{" "}
							{m.settings_change_password_dialog_warning_recovery_key_setup()}
						</p>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
						>
							{m.settings_common_action_cancel()}
						</Button>
						<Button type="submit" disabled={isProcessing}>
							{isProcessing
								? m.settings_change_password_dialog_action_changing()
								: m.settings_change_password_dialog_action_submit()}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
