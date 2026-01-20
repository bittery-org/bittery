import { arrayBufferToBase64 } from "@bittery/crypto/key-derivation";
import { rsaEncrypt } from "@bittery/crypto/rsa";
import { getDecryptedVaultKey } from "@bittery/crypto/session-storage";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import {
	Avatar,
	AvatarFallback,
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from "@bittery/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { useState } from "react";
import { useQueryInvalidator } from "../../providers/sync-provider";

interface AddMemberDialogProps {
	vaultId: string;
}

export function AddMemberDialog({ vaultId }: AddMemberDialogProps) {
	const [open, setOpen] = useState(false);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"admin" | "member" | "read-only">("member");
	const [searchedEmail, setSearchedEmail] = useState("");

	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	// Look up user by email
	const userQuery = useQuery({
		...trpc.vault.members.lookupUser.queryOptions({ email: searchedEmail }),
		enabled: searchedEmail.length > 0 && searchedEmail.includes("@"),
		retry: false,
	});

	const addMemberMutation = useMutation({
		mutationFn: async (input: {
			vaultId: string;
			userId: string;
			role: "admin" | "member" | "read-only";
			encryptedVaultKey: string;
		}) => trpcClient.vault.members.add.mutate(input),
		onSuccess: async () => {
			toast.success("Member added successfully");
			await invalidator.invalidateVaultMembers(vaultId);
			setOpen(false);
			resetForm();
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const resetForm = () => {
		setEmail("");
		setSearchedEmail("");
		setRole("member");
	};

	const handleSearch = (e: React.FormEvent) => {
		e.preventDefault();
		setSearchedEmail(email.trim().toLowerCase());
	};

	const handleAddMember = async () => {
		if (!userQuery.data) return;

		try {
			// 1. Get the decrypted vault key
			const vaultKey = await getDecryptedVaultKey(vaultId);
			if (!vaultKey) {
				toast.error("Could not decrypt vault key. Please log in again.");
				return;
			}

			// 2. Convert vault key to base64 for encryption
			const vaultKeyBase64 = arrayBufferToBase64(vaultKey);

			// 3. Encrypt the vault key with the new member's RSA public key
			const encryptedVaultKey = await rsaEncrypt(
				vaultKeyBase64,
				userQuery.data.publicKey,
			);

			// 4. Add the member
			addMemberMutation.mutate({
				vaultId,
				userId: userQuery.data.id,
				role,
				encryptedVaultKey,
			});
		} catch (error) {
			toast.error("Failed to encrypt vault key for new member");
			console.error(error);
		}
	};

	const getInitials = (name: string) =>
		name
			.split(" ")
			.map((n) => n[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button>
					<UserPlus className="mr-2 h-4 w-4" />
					Add Member
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add Member to Vault</DialogTitle>
					<DialogDescription>
						Search for a user by email to add them to this vault. They will be
						able to access all items based on their assigned role.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSearch} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="email">Email Address</Label>
						<div className="flex gap-2">
							<Input
								id="email"
								type="email"
								placeholder="user@example.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								className="flex-1"
							/>
							<Button
								type="submit"
								variant="secondary"
								disabled={!email.includes("@")}
							>
								Search
							</Button>
						</div>
					</div>
				</form>

				{userQuery.isLoading && (
					<p className="text-muted-foreground text-sm">Searching...</p>
				)}

				{userQuery.isError && searchedEmail && (
					<p className="text-destructive text-sm">
						{userQuery.error.message === "User not found"
							? "No user found with this email address."
							: userQuery.error.message}
					</p>
				)}

				{userQuery.data && (
					<div className="space-y-4">
						<div className="flex items-center gap-3 rounded-lg border p-3">
							<Avatar className="h-10 w-10">
								<AvatarFallback>
									{getInitials(userQuery.data.name)}
								</AvatarFallback>
							</Avatar>
							<div className="min-w-0 flex-1">
								<div className="font-medium">{userQuery.data.name}</div>
								<div className="truncate text-muted-foreground text-sm">
									{userQuery.data.email}
								</div>
							</div>
						</div>

						<div className="space-y-2">
							<Label htmlFor="role">Role</Label>
							<Select
								value={role}
								onValueChange={(value: "admin" | "member" | "read-only") =>
									setRole(value)
								}
							>
								<SelectTrigger id="role">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="admin">
										<div>
											<div>Admin</div>
											<div className="text-muted-foreground text-xs">
												Can manage members and items
											</div>
										</div>
									</SelectItem>
									<SelectItem value="member">
										<div>
											<div>Member</div>
											<div className="text-muted-foreground text-xs">
												Can view and edit items
											</div>
										</div>
									</SelectItem>
									<SelectItem value="read-only">
										<div>
											<div>Read-only</div>
											<div className="text-muted-foreground text-xs">
												Can only view items
											</div>
										</div>
									</SelectItem>
								</SelectContent>
							</Select>
						</div>

						<DialogFooter>
							<Button variant="outline" onClick={() => setOpen(false)}>
								Cancel
							</Button>
							<Button
								onClick={handleAddMember}
								disabled={addMemberMutation.isPending}
							>
								{addMemberMutation.isPending ? "Adding..." : "Add Member"}
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
