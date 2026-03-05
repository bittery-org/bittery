import {
	buildVaultKeyEncryptionContext,
	isAesEncryptedVaultKey,
} from "@bittery/shared";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import {
	Button,
	copyWithToast,
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
	IconCopyOutlineDuo18 as Copy,
	IconClipboardArrowInOutlineDuo18 as Download,
	IconEyeOutlineDuo18 as Eye,
	IconEyeSlashOutlineDuo18 as EyeOff,
	IconArrowsLeftRightTrailOutlineDuo18 as RefreshCw,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { downloadRecoveryKit } from "@/lib/recovery-kit";
import { storage } from "@/lib/storage";
import {
	decrypt,
	deriveKeys,
	encrypt,
	generateSecretKey,
	generateSRPRegistration,
	getSecretKeyHint,
} from "@/lib/wasm-crypto";
import { useI18n } from "@/providers/i18n-provider";

export function RegenerateSecretKeyDialog({
	userEmail,
}: {
	userEmail: string;
}) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<"confirm" | "display">("confirm");
	const [currentPassword, setCurrentPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [newSecretKey, setNewSecretKey] = useState("");
	const [hasAcknowledged, setHasAcknowledged] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);
	const trpcClient = useTRPCClient();
	const trpc = useTRPC();

	const userQuery = useQuery(trpc.auth.me.queryOptions());
	const vaultListQuery = useQuery(trpc.vault.list.queryOptions());

	const handleGenerateNewKey = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!currentPassword.trim()) {
			toast.error(
				m["settings.secret_key.regenerate.toast.current_password_required"](),
			);
			return;
		}

		const oldSecretKey = await storage.getStoredSecretKey();
		if (!oldSecretKey) {
			toast.error(m["settings.common.toast.secret_key_not_found"]());
			return;
		}

		if (!userQuery.data?.encryptedPrivateKey) {
			toast.error(m["settings.common.toast.user_data_load_failed"]());
			return;
		}

		setIsProcessing(true);

		try {
			// 1. Derive old keys to decrypt private key
			const { masterUnlockKey: oldMasterUnlockKey } = await deriveKeys(
				currentPassword,
				oldSecretKey,
				userEmail,
			);

			// 2. Decrypt private key with old master unlock key to verify password is correct
			const encryptedPrivateKeyData = JSON.parse(
				userQuery.data.encryptedPrivateKey,
			);
			await decrypt(encryptedPrivateKeyData, oldMasterUnlockKey);

			// 3. Generate new secret key
			const generatedSecretKey = generateSecretKey();
			setNewSecretKey(generatedSecretKey);
			setStep("display");
			setIsProcessing(false);
		} catch (error) {
			console.error("Secret key regeneration error:", error);
			toast.error(
				m["settings.secret_key.regenerate.toast.verify_password_failed"](),
			);
			setIsProcessing(false);
		}
	};

	const handleConfirmRegeneration = async () => {
		if (!hasAcknowledged) {
			toast.error(
				m["settings.secret_key.regenerate.toast.acknowledgement_required"](),
			);
			return;
		}

		const oldSecretKey = await storage.getStoredSecretKey();
		if (!oldSecretKey) {
			toast.error(
				m["settings.secret_key.regenerate.toast.secret_key_not_found"](),
			);
			return;
		}

		if (!userQuery.data?.encryptedPrivateKey) {
			toast.error(
				m["settings.secret_key.regenerate.toast.user_data_load_failed"](),
			);
			return;
		}

		if (!vaultListQuery.data || vaultListQuery.data.length === 0) {
			toast.error(m["settings.common.toast.vault_keys_load_failed"]());
			return;
		}

		setIsProcessing(true);

		try {
			// 1. Derive old keys to decrypt private key
			const { masterUnlockKey: oldMasterUnlockKey } = await deriveKeys(
				currentPassword,
				oldSecretKey,
				userEmail,
			);

			// 2. Decrypt private key with old master unlock key
			const encryptedPrivateKeyData = JSON.parse(
				userQuery.data.encryptedPrivateKey,
			);
			const privateKey = await decrypt(
				encryptedPrivateKeyData,
				oldMasterUnlockKey,
			);

			// 3. Derive new keys with new secret key
			const { authKey: newAuthKey, masterUnlockKey: newMasterUnlockKey } =
				await deriveKeys(currentPassword, newSecretKey, userEmail);

			// 4. Generate new SRP credentials
			const authKeyString = new TextDecoder().decode(newAuthKey);
			const { salt: srpSalt, verifier: srpVerifier } =
				await generateSRPRegistration(authKeyString);

			// 5. Re-encrypt private key with new master unlock key
			const newEncryptedPrivateKey = await encrypt(
				privateKey,
				newMasterUnlockKey,
			);

			// 6. Re-encrypt vault keys with new master unlock key
			// Only re-encrypt vault keys for vaults the user created (MUK-encrypted)
			// Shared vault keys are RSA-encrypted and don't need re-encryption
			const serverVaultKeys = vaultListQuery.data;
			const currentUserId = userQuery.data.id;
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

				// Decrypt vault key with old MUK
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
					userId: currentUserId,
					keyVersion,
				});
				const decryptedVaultKeyBase64 = await decrypt(
					encryptedVaultKeyData,
					oldMasterUnlockKey,
					vaultKeyContext,
				);

				// Re-encrypt vault key with new MUK
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

			// 7. Send to server (other sessions are invalidated, current one is kept)
			await trpcClient.auth.regenerateSecretKey.mutate({
				secretKeyHint: getSecretKeyHint(newSecretKey),
				srpSalt,
				srpVerifier,
				encryptedPrivateKey: JSON.stringify(newEncryptedPrivateKey),
				encryptedVaultKeys,
			});

			// 8. Update local state — store new secret key and new MUK
			await storage.storeSecretKey(newSecretKey, userEmail);
			await storage.setMasterUnlockKey(newMasterUnlockKey, userEmail);
			await storage.storeSessionData(
				newMasterUnlockKey,
				userEmail,
				currentUserId,
			);

			toast.success(m["settings.secret_key.regenerate.toast.regenerated"]());
			setOpen(false);
		} catch (error) {
			console.error("Secret key regeneration error:", error);
			toast.error(
				m["settings.secret_key.regenerate.toast.regenerate_failed"](),
			);
			setIsProcessing(false);
		}
	};

	const copySecretKey = () => {
		copyWithToast(
			newSecretKey,
			m["settings.secret_key.regenerate.copy_label"](),
			{
				showAutoClearMessage: false,
			},
		);
	};

	const downloadKit = async () => {
		const result = await downloadRecoveryKit({
			fileName: "bittery-new-secret-key",
			title: m["settings.secret_key.regenerate.kit.title"](),
			subtitle: m["settings.secret_key.regenerate.kit.subtitle"](),
			entries: [
				{
					label: m["settings.secret_key.regenerate.kit.entry.label"](),
					value: newSecretKey,
					description:
						m["settings.secret_key.regenerate.kit.entry.description"](),
				},
			],
			cautions: [
				m["settings.secret_key.regenerate.kit.caution.destroy_old"](),
				m["settings.secret_key.regenerate.kit.caution.store_offline"](),
				m["settings.secret_key.regenerate.kit.caution.setup_recovery_key"](),
			],
			footerNote: m["settings.recovery_key.common.kit.footer_note"](),
			includeHandwrittenPasswordSection: true,
			labels: {
				documentTitle: m["settings.recovery_key.common.kit.document_title"](),
				generatedLabel: m["settings.recovery_key.common.kit.generated_label"](),
				storeOfflineHeading:
					m["settings.recovery_key.common.kit.store_offline_heading"](),
				badgeText: m["settings.recovery_key.common.kit.badge_text"](),
				handwrittenTitle:
					m["settings.secret_key.regenerate.kit.handwritten_title"](),
				handwrittenDescription:
					m["settings.secret_key.regenerate.kit.handwritten_description"](),
				handwrittenPasswordLabel:
					m["settings.secret_key.regenerate.kit.handwritten_password_label"](),
			},
		});

		if (result === "pdf-downloaded") {
			toast.success(
				m["settings.secret_key.regenerate.toast.kit_pdf_downloaded"](),
			);
			return;
		}
		toast.success(
			m["settings.secret_key.regenerate.toast.kit_text_downloaded"](),
		);
	};

	const handleOpenChange = (newOpen: boolean) => {
		setOpen(newOpen);
		if (!newOpen) {
			// Reset state when closing
			setStep("confirm");
			setCurrentPassword("");
			setNewSecretKey("");
			setHasAcknowledged(false);
			setIsProcessing(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<RefreshCw className="mr-2 h-4 w-4" />
					{m["settings.secret_key.regenerate.trigger"]()}
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				{step === "confirm" ? (
					<form onSubmit={handleGenerateNewKey}>
						<DialogHeader>
							<DialogTitle>
								{m["settings.secret_key.regenerate.title"]()}
							</DialogTitle>
							<DialogDescription>
								{m["settings.secret_key.regenerate.description"]()}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
								<p className="text-destructive text-xs">
									<strong>{m["settings.common.warning"]()}</strong>{" "}
									{m["settings.secret_key.regenerate.warning"]()}
								</p>
							</div>
							<div className="grid gap-2">
								<Label htmlFor="currentPassword">
									{m["settings.secret_key.regenerate.field.password"]()}
								</Label>
								<div className="relative">
									<Input
										id="currentPassword"
										type={showPassword ? "text" : "password"}
										value={currentPassword}
										onChange={(e) => setCurrentPassword(e.target.value)}
										placeholder={m[
											"settings.secret_key.regenerate.placeholder.password"
										]()}
										autoFocus
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
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								{m["settings.common.action.cancel"]()}
							</Button>
							<Button
								type="submit"
								variant="destructive"
								disabled={isProcessing}
							>
								{isProcessing
									? m["settings.recovery_key.common.action.verifying"]()
									: m["settings.secret_key.regenerate.action.generate"]()}
							</Button>
						</DialogFooter>
					</form>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>
								{m["settings.secret_key.regenerate.display.title"]()}
							</DialogTitle>
							<DialogDescription>
								{m["settings.secret_key.regenerate.display.description"]()}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="relative rounded-xl border bg-muted/30 p-4">
								<div className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
									{m["settings.secret_key.regenerate.display.key_label"]()}
								</div>
								<div className="break-all font-mono text-sm tracking-wide">
									{newSecretKey}
								</div>
							</div>

							<div className="grid grid-cols-2 gap-3">
								<Button
									type="button"
									variant="outline"
									className="w-full"
									onClick={copySecretKey}
								>
									<Copy size={16} className="mr-2" />
									{m["settings.common.action.copy"]()}
								</Button>
								<Button
									type="button"
									variant="outline"
									className="w-full"
									onClick={downloadKit}
								>
									<Download size={16} className="mr-2" />
									{m["settings.common.action.download_kit"]()}
								</Button>
							</div>

							<div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
								<p className="text-amber-700 text-xs dark:text-amber-300">
									<strong>
										{m["settings.secret_key.regenerate.important"]()}
									</strong>{" "}
									{m[
										"settings.secret_key.regenerate.display.recovery_key_notice"
									]()}
								</p>
							</div>

							<label className="flex items-start gap-2">
								<input
									type="checkbox"
									checked={hasAcknowledged}
									onChange={(e) => setHasAcknowledged(e.target.checked)}
									className="mt-1"
								/>
								<span className="text-sm">
									{m[
										"settings.secret_key.regenerate.display.acknowledgement"
									]()}
								</span>
							</label>
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								{m["settings.common.action.cancel"]()}
							</Button>
							<Button
								type="button"
								onClick={handleConfirmRegeneration}
								disabled={!hasAcknowledged || isProcessing}
							>
								{isProcessing
									? m["settings.common.action.saving"]()
									: m["settings.secret_key.regenerate.action.confirm"]()}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
