import {
	buildVaultKeyEncryptionContext,
	isAesEncryptedVaultKey,
} from "@bittery/shared";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
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
	IconEyeOutlineDuo18 as Eye,
	IconEyeSlashOutlineDuo18 as EyeOff,
	IconEnvelopeOutlineDuo18 as Mail,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { storage } from "@/lib/storage";
import {
	decrypt,
	deriveKeys,
	encrypt,
	generateSRPRegistration,
} from "@/lib/wasm-crypto";
import { useI18n } from "@/providers/i18n-provider";

export function ChangeEmailDialog({ currentEmail }: { currentEmail: string }) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [newEmail, setNewEmail] = useState("");
	const [confirmEmail, setConfirmEmail] = useState("");
	const [currentPassword, setCurrentPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);
	const trpcClient = useTRPCClient();
	const trpc = useTRPC();
	const navigate = useNavigate();

	const userQuery = useQuery(trpc.auth.me.queryOptions());
	const vaultListQuery = useQuery(trpc.vault.list.queryOptions());

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!newEmail.trim()) {
			toast.error(m["settings.change_email_dialog.toast.new_email_required"]());
			return;
		}
		if (newEmail !== confirmEmail) {
			toast.error(m["settings.change_email_dialog.toast.email_mismatch"]());
			return;
		}
		if (newEmail.toLowerCase() === currentEmail.toLowerCase()) {
			toast.error(m["settings.change_email_dialog.toast.email_must_differ"]());
			return;
		}
		if (!currentPassword.trim()) {
			toast.error(m["settings.change_email_dialog.toast.password_required"]());
			return;
		}

		const secretKey = await storage.getStoredSecretKey();
		if (!secretKey) {
			toast.error(m["settings.common.toast.secret_key_not_found"]());
			return;
		}

		if (!userQuery.data?.encryptedPrivateKey) {
			toast.error(m["settings.common.toast.user_data_load_failed"]());
			return;
		}

		if (!vaultListQuery.data || vaultListQuery.data.length === 0) {
			toast.error(m["settings.common.toast.vault_keys_load_failed"]());
			return;
		}

		setIsProcessing(true);

		try {
			// 1. Derive old keys with current email
			const { masterUnlockKey: oldMasterUnlockKey } = await deriveKeys(
				currentPassword,
				secretKey,
				currentEmail,
			);

			// 2. Decrypt private key with old MUK to verify password
			const encryptedPrivateKeyData = JSON.parse(
				userQuery.data.encryptedPrivateKey,
			);
			const privateKey = await decrypt(
				encryptedPrivateKeyData,
				oldMasterUnlockKey,
			);

			// 3. Derive new keys with new email (same password, same secret key)
			const normalizedNewEmail = newEmail.trim().toLowerCase();
			const { authKey: newAuthKey, masterUnlockKey: newMasterUnlockKey } =
				await deriveKeys(currentPassword, secretKey, normalizedNewEmail);

			// 4. Generate new SRP credentials
			const authKeyString = new TextDecoder().decode(newAuthKey);
			const { salt: srpSalt, verifier: srpVerifier } =
				await generateSRPRegistration(authKeyString);

			// 5. Re-encrypt private key with new MUK
			const newEncryptedPrivateKey = await encrypt(
				privateKey,
				newMasterUnlockKey,
			);

			// 6. Re-encrypt vault keys with new MUK
			const serverVaultKeys = vaultListQuery.data;
			const encryptedVaultKeys: Array<{
				vaultId: string;
				encryptedVaultKey: string;
			}> = [];

			for (const vk of serverVaultKeys) {
				// Only re-encrypt AES(MUK)-wrapped keys.
				// RSA-wrapped keys are not tied to the master unlock key.
				if (!isAesEncryptedVaultKey(vk.encryptedVaultKey)) {
					continue;
				}

				const encryptedVaultKeyData = JSON.parse(vk.encryptedVaultKey) as {
					ciphertext: string;
					iv: string;
					algorithm: string;
					context?: { keyVersion?: number };
				};
				const keyVersion = Number.isInteger(
					encryptedVaultKeyData.context?.keyVersion,
				)
					? (encryptedVaultKeyData.context?.keyVersion as number)
					: 1;
				const vaultKeyContext = buildVaultKeyEncryptionContext({
					vaultId: vk.id,
					userId: userQuery.data.id,
					keyVersion,
				});
				const decryptedVaultKeyBase64 = await decrypt(
					encryptedVaultKeyData,
					oldMasterUnlockKey,
					vaultKeyContext,
				);

				const newEncryptedVaultKey = await encrypt(
					decryptedVaultKeyBase64,
					newMasterUnlockKey,
					vaultKeyContext,
				);

				encryptedVaultKeys.push({
					vaultId: vk.id,
					encryptedVaultKey: JSON.stringify(newEncryptedVaultKey),
				});
			}

			// 7. Send to server
			await trpcClient.auth.updateEmail.mutate({
				newEmail: normalizedNewEmail,
				srpSalt,
				srpVerifier,
				encryptedPrivateKey: JSON.stringify(newEncryptedPrivateKey),
				encryptedVaultKeys,
			});

			toast.success(m["settings.change_email_dialog.toast.updated"]());
			setOpen(false);
			navigate({ to: "/login" });
		} catch (error) {
			console.error("Email change error:", error);
			toast.error(m["settings.change_email_dialog.toast.update_failed"]());
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
					{m["settings.change_email_dialog.trigger"]()}
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>
							{m["settings.change_email_dialog.title"]()}
						</DialogTitle>
						<DialogDescription>
							{m["settings.change_email_dialog.description"]()}
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="currentEmail">
								{m["settings.change_email_dialog.field.current_email"]()}
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
								{m["settings.change_email_dialog.field.new_email"]()}
							</Label>
							<Input
								id="newEmail"
								type="email"
								value={newEmail}
								onChange={(e) => setNewEmail(e.target.value)}
								placeholder={m[
									"settings.change_email_dialog.placeholder.new_email"
								]()}
								autoFocus
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="confirmEmail">
								{m["settings.change_email_dialog.field.confirm_new_email"]()}
							</Label>
							<Input
								id="confirmEmail"
								type="email"
								value={confirmEmail}
								onChange={(e) => setConfirmEmail(e.target.value)}
								placeholder={m[
									"settings.change_email_dialog.placeholder.confirm_new_email"
								]()}
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="emailChangePassword">
								{m["settings.change_email_dialog.field.password"]()}
							</Label>
							<div className="relative">
								<Input
									id="emailChangePassword"
									type={showPassword ? "text" : "password"}
									value={currentPassword}
									onChange={(e) => setCurrentPassword(e.target.value)}
									placeholder={m[
										"settings.change_email_dialog.placeholder.password"
									]()}
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
							<strong>{m["settings.common.warning"]()}</strong>{" "}
							{m["settings.change_email_dialog.warning.recovery_key_reset"]()}
						</p>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
						>
							{m["settings.common.action.cancel"]()}
						</Button>
						<Button type="submit" disabled={isProcessing}>
							{isProcessing
								? m["settings.change_email_dialog.action.updating"]()
								: m["settings.change_email_dialog.action.submit"]()}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
