import {
	decryptStoredVaultKey,
	type VaultKeyCryptoProvider,
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from "@bittery/ui";
import {
	IconCopyOutlineDuo18 as Copy,
	IconUsers6OutlineDuo18 as UserPlus,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { storage } from "@/lib/storage";
import { decrypt, rsaDecrypt, rsaEncrypt } from "@/lib/wasm-crypto";
import { useQueryInvalidator } from "../../providers/sync-provider";

interface InviteDialogProps {
	teamId: string;
}

export function InviteDialog({ teamId }: InviteDialogProps) {
	const [open, setOpen] = useState(false);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"admin" | "member">("member");
	const [inviteLink, setInviteLink] = useState<string | null>(null);
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	// Query team vaults for key provisioning
	const teamVaultsQuery = useQuery({
		...trpc.team.vaults.queryOptions({ teamId }),
		enabled: open, // Only fetch when dialog is open
	});

	const inviteMutation = useMutation({
		mutationFn: async (input: {
			teamId: string;
			email: string;
			role: "admin" | "member";
		}) => {
			// First, send the invitation to get user's public key (if they exist)
			const result = await trpcClient.team.invitations.send.mutate(input);

			// If the user already exists and has a public key, we need to provision vault keys
			if (result.existingUserPublicKey && teamVaultsQuery.data) {
				const pendingVaultKeys: Array<{
					vaultId: string;
					encryptedVaultKey: string;
				}> = [];

				// For each team vault, decrypt the key and re-encrypt with invitee's public key
				for (const vault of teamVaultsQuery.data) {
					if (vault.encryptedVaultKey) {
						try {
							// Decrypt vault key with our MUK
							const vaultKey = await decryptStoredVaultKey({
								encryptedVaultKey: vault.encryptedVaultKey,
								storage,
								crypto: {
									decrypt,
									rsaDecrypt,
								} as VaultKeyCryptoProvider,
							});

							// Convert vault key to base64 string for RSA encryption
							const vaultKeyBase64 = btoa(
								String.fromCharCode(...new Uint8Array(vaultKey)),
							);

							// Encrypt with invitee's RSA public key
							const encryptedForInvitee = await rsaEncrypt(
								vaultKeyBase64,
								result.existingUserPublicKey,
							);

							pendingVaultKeys.push({
								vaultId: vault.id,
								encryptedVaultKey: encryptedForInvitee,
							});
						} catch (err) {
							console.error(
								`Failed to provision vault key for vault ${vault.id}:`,
								err,
							);
						}
					}
				}

				// If we have vault keys to provision, update the invitation
				if (pendingVaultKeys.length > 0) {
					// Cancel the existing invitation and create a new one with vault keys
					await trpcClient.team.invitations.cancel.mutate({
						invitationId: result.invitationId,
					});
					return trpcClient.team.invitations.send.mutate({
						...input,
						pendingVaultKeys,
					});
				}
			}

			return result;
		},
		onSuccess: async (data) => {
			const url = `${window.location.origin}/invite/${data.token}`;
			setInviteLink(url);
			toast.success("Invitation created. Copy the invite link to share.");
			await invalidator.invalidateTeam();
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!email.trim()) return;
		inviteMutation.mutate({ teamId, email: email.trim(), role });
	};

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			setEmail("");
			setRole("member");
			setInviteLink(null);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button>
					<UserPlus className="mr-2 h-4 w-4" />
					Invite Member
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>Invite Member</DialogTitle>
						<DialogDescription>
							Send an invitation to join this team.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="email">Email Address</Label>
							<Input
								id="email"
								type="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								placeholder="colleague@example.com"
								autoFocus
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="role">Role</Label>
							<Select
								value={role}
								onValueChange={(v: "admin" | "member") => setRole(v)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="member">Member</SelectItem>
									<SelectItem value="admin">Admin</SelectItem>
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								Admins can invite members and manage team settings.
							</p>
						</div>
						{inviteLink && (
							<div className="rounded-md border bg-muted/40 p-3">
								<p className="mb-2 font-medium text-sm">Invite Link</p>
								<p className="break-all text-muted-foreground text-xs">
									{inviteLink}
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="mt-3"
									onClick={() =>
										copyWithToast(inviteLink, "Invite link", {
											showAutoClearMessage: false,
										})
									}
								>
									<Copy className="mr-2 h-4 w-4" />
									Copy link
								</Button>
							</div>
						)}
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={inviteMutation.isPending}>
							{inviteMutation.isPending ? "Sending..." : "Create Invitation"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
