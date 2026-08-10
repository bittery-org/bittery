import { usePlatformCrypto } from "@bittery/core/hooks";
import {
	changeAccountEmail,
	InvalidAccountPasswordError,
	LocalKeyAdoptionError,
} from "@bittery/core/services/vault-crypto";
import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
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
	IconMail as Mail,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

export function ChangeEmailDialog({ currentEmail }: { currentEmail: string }) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [newEmail, setNewEmail] = useState("");
	const [confirmEmail, setConfirmEmail] = useState("");
	const [currentPassword, setCurrentPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);
	const api = useApiClient();
	const crypto = usePlatformCrypto();
	const navigate = useNavigate();

	const userQuery = useQuery(apiQueries.auth.me(api));
	const vaultListQuery = useQuery(apiQueries.vaults.list(api));

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!newEmail.trim()) {
			toast.error(m.settings_change_email_dialog_toast_new_email_required());
			return;
		}
		if (newEmail !== confirmEmail) {
			toast.error(m.settings_change_email_dialog_toast_email_mismatch());
			return;
		}
		if (newEmail.toLowerCase() === currentEmail.toLowerCase()) {
			toast.error(m.settings_change_email_dialog_toast_email_must_differ());
			return;
		}
		if (!currentPassword.trim()) {
			toast.error(m.settings_change_email_dialog_toast_password_required());
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
			await changeAccountEmail(
				{
					accountId,
					currentEmail,
					newEmail,
					userId: userQuery.data.id,
					currentPassword,
					secretKey,
					encryptedPrivateKey: userQuery.data.encryptedPrivateKey,
					vaultKeys: vaultListQuery.data.map((vault) =>
						toVaultKeyEntry({
							...vault,
							icon: vault.icon ?? null,
							imageUrl: vault.imageUrl ?? null,
						}),
					),
				},
				{
					crypto,
					storage,
					commit: (payload) =>
						api.auth.changeEmail(payload).then((r) => r.data),
				},
			);

			toast.success(m.settings_change_email_dialog_toast_updated());
			setOpen(false);
			navigate({ to: "/login" });
		} catch (error) {
			// The address on the account has already changed; a retry would sign in as an
			// account that no longer exists.
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
			console.error("Email change error:", error);
			toast.error(m.settings_change_email_dialog_toast_update_failed());
			setIsProcessing(false);
		}
	};

	const handleOpenChange = (newOpen: boolean) => {
		setOpen(newOpen);
		if (!newOpen) {
			setNewEmail("");
			setConfirmEmail("");
			setCurrentPassword("");
			setShowPassword(false);
			setIsProcessing(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Mail className="mr-2 h-4 w-4" />
					{m.settings_change_email_dialog_trigger()}
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>{m.settings_change_email_dialog_title()}</DialogTitle>
						<DialogDescription>
							{m.settings_change_email_dialog_description()}
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="currentEmail">
								{m.settings_change_email_dialog_field_current_email()}
							</Label>
							<Input
								id="currentEmail"
								value={currentEmail}
								disabled
								className="bg-muted"
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="newEmail">
								{m.settings_change_email_dialog_field_new_email()}
							</Label>
							<Input
								id="newEmail"
								type="email"
								value={newEmail}
								onChange={(e) => setNewEmail(e.target.value)}
								placeholder={m.settings_change_email_dialog_placeholder_new_email()}
								autoFocus
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="confirmEmail">
								{m.settings_change_email_dialog_field_confirm_new_email()}
							</Label>
							<Input
								id="confirmEmail"
								type="email"
								value={confirmEmail}
								onChange={(e) => setConfirmEmail(e.target.value)}
								placeholder={m.settings_change_email_dialog_placeholder_confirm_new_email()}
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="emailChangePassword">
								{m.settings_change_email_dialog_field_password()}
							</Label>
							<div className="relative">
								<Input
									id="emailChangePassword"
									type={showPassword ? "text" : "password"}
									value={currentPassword}
									onChange={(e) => setCurrentPassword(e.target.value)}
									placeholder={m.settings_change_email_dialog_placeholder_password()}
									className="pr-10"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="absolute top-0 right-0 h-full w-10 text-muted-foreground hover:text-foreground"
									onClick={() => setShowPassword(!showPassword)}
								>
									{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
								</Button>
							</div>
						</div>
					</div>
					<div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
						<p className="text-amber-700 text-xs dark:text-amber-300">
							<strong>{m.settings_common_warning()}</strong>{" "}
							{m.settings_change_email_dialog_warning_recovery_key_reset()}
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
								? m.settings_change_email_dialog_action_updating()
								: m.settings_change_email_dialog_action_submit()}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
