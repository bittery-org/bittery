import { decrypt } from "@bittery/crypto/encryption";
import { encryptExport } from "@bittery/crypto/export-encryption";
import { getDecryptedVaultKey } from "@bittery/crypto/session-storage";
import type {
	EncryptedVaultExport,
	ExportedItem,
	ExportedVault,
	VaultExportPayload,
} from "@bittery/shared/export-types";
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
	Progress,
	toast,
} from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { Download, Eye, EyeOff, Lock, ShieldCheck } from "lucide-react";
import { useState } from "react";

interface ExportVaultDialogProps {
	userEmail: string;
	userName?: string;
}

export function ExportVaultDialog({
	userEmail,
	userName,
}: ExportVaultDialogProps) {
	const [open, setOpen] = useState(false);
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [isExporting, setIsExporting] = useState(false);
	const [progress, setProgress] = useState(0);
	const [progressText, setProgressText] = useState("");

	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const vaultsQuery = useQuery(trpc.vault.list.queryOptions());

	const validatePassword = (): boolean => {
		if (!password.trim()) {
			toast.error("Please enter a password");
			return false;
		}
		if (password.length < 8) {
			toast.error("Password must be at least 8 characters");
			return false;
		}
		if (password !== confirmPassword) {
			toast.error("Passwords do not match");
			return false;
		}
		return true;
	};

	const handleExport = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!validatePassword()) {
			return;
		}

		if (!vaultsQuery.data || vaultsQuery.data.length === 0) {
			toast.error("No vaults found to export");
			return;
		}

		setIsExporting(true);
		setProgress(0);
		setProgressText("Preparing export...");

		try {
			const vaults = vaultsQuery.data;
			const exportedVaults: ExportedVault[] = [];
			let totalItems = 0;

			// Process each vault
			for (let i = 0; i < vaults.length; i++) {
				const vault = vaults[i];
				setProgressText(`Processing vault: ${vault.name}`);
				setProgress(Math.round(((i + 0.3) / vaults.length) * 80));

				// Get items for this vault using tRPC client directly
				const items = await trpcClient.vault.listItems.query({
					vaultId: vault.id,
				});

				if (!items || items.length === 0) {
					exportedVaults.push({
						id: vault.id,
						name: vault.name,
						type: vault.type,
						icon: vault.icon ?? undefined,
						items: [],
					});
					continue;
				}

				setProgressText(
					`Decrypting ${items.length} items from ${vault.name}...`,
				);
				setProgress(Math.round(((i + 0.6) / vaults.length) * 80));

				// Get vault key for decryption
				const vaultKey = await getDecryptedVaultKey(vault.id);
				if (!vaultKey) {
					console.error(`No vault key found for vault ${vault.id}`);
					continue;
				}

				// Decrypt all items
				const decryptedItems: ExportedItem[] = [];
				for (const item of items) {
					try {
						const decryptedData = await decrypt(
							{
								ciphertext: item.encryptedData,
								iv: item.encryptionIv,
								algorithm: item.encryptionAlgorithm,
							},
							vaultKey,
						);

						const parsedData = JSON.parse(decryptedData);

						decryptedItems.push({
							id: item.id,
							category: item.category,
							favorite: item.favorite,
							data: parsedData,
							createdAt: item.createdAt,
							updatedAt: item.updatedAt,
						});
					} catch (error) {
						console.error(`Failed to decrypt item ${item.id}:`, error);
					}
				}

				exportedVaults.push({
					id: vault.id,
					name: vault.name,
					type: vault.type,
					icon: vault.icon ?? undefined,
					items: decryptedItems,
				});

				totalItems += decryptedItems.length;
			}

			setProgressText("Encrypting export data...");
			setProgress(85);

			// Create the export payload
			const payload: VaultExportPayload = {
				version: "1.0",
				exportDate: new Date().toISOString(),
				exportedBy: {
					email: userEmail,
					name: userName,
				},
				vaults: exportedVaults,
				metadata: {
					totalItems,
					totalVaults: exportedVaults.length,
				},
			};

			// Encrypt the payload
			const encryptedData = await encryptExport(
				JSON.stringify(payload),
				password,
			);

			// Create the final export format
			const exportFile: EncryptedVaultExport = {
				format: "bittery-encrypted-export",
				version: "1.0",
				exportDate: payload.exportDate,
				encryption: encryptedData,
			};

			setProgressText("Preparing download...");
			setProgress(95);

			// Create and download the file
			const blob = new Blob([JSON.stringify(exportFile, null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			const date = new Date().toISOString().split("T")[0];
			a.download = `bittery-export-${date}.json`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);

			setProgress(100);
			setProgressText("Export complete!");

			toast.success(
				`Successfully exported ${totalItems} items from ${exportedVaults.length} vault(s)`,
			);

			// Reset and close
			setTimeout(() => {
				setOpen(false);
				setPassword("");
				setConfirmPassword("");
				setIsExporting(false);
				setProgress(0);
				setProgressText("");
			}, 1000);
		} catch (error) {
			console.error("Export failed:", error);
			toast.error("Failed to export vault data. Please try again.");
			setIsExporting(false);
			setProgress(0);
			setProgressText("");
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Download className="mr-2 h-4 w-4" />
					Export Data
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={handleExport}>
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<Lock className="h-5 w-5" />
							Export Encrypted Backup
						</DialogTitle>
						<DialogDescription>
							Export all your vault data in an encrypted JSON file. You'll need
							this password to restore the backup later.
						</DialogDescription>
					</DialogHeader>

					{isExporting ? (
						<div className="space-y-4 py-6">
							<div className="space-y-2">
								<div className="flex justify-between text-sm">
									<span className="text-muted-foreground">{progressText}</span>
									<span className="font-medium">{progress}%</span>
								</div>
								<Progress value={progress} className="h-2" />
							</div>
						</div>
					) : (
						<div className="grid gap-4 py-4">
							<div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
								<div className="flex gap-2">
									<ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
									<div className="text-blue-700 text-xs dark:text-blue-300">
										<strong>End-to-end encrypted:</strong> Your data is
										encrypted with your password before leaving this device.
										Even Bittery cannot read your export.
									</div>
								</div>
							</div>

							<div className="grid gap-2">
								<Label htmlFor="exportPassword">Encryption Password</Label>
								<div className="relative">
									<Input
										id="exportPassword"
										type={showPassword ? "text" : "password"}
										value={password}
										onChange={(e) => setPassword(e.target.value)}
										placeholder="Enter a strong password"
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
								<p className="text-muted-foreground text-xs">
									Must be at least 8 characters. Use a strong, unique password.
								</p>
							</div>

							<div className="grid gap-2">
								<Label htmlFor="confirmExportPassword">Confirm Password</Label>
								<Input
									id="confirmExportPassword"
									type="password"
									value={confirmPassword}
									onChange={(e) => setConfirmPassword(e.target.value)}
									placeholder="Confirm your password"
								/>
							</div>

							<div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
								<p className="text-amber-700 text-xs dark:text-amber-300">
									<strong>Important:</strong> Remember this password! Without
									it, you won't be able to restore this backup. Store it in a
									safe place.
								</p>
							</div>
						</div>
					)}

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
							disabled={isExporting}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={isExporting}>
							{isExporting ? "Exporting..." : "Export Backup"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
