import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { encrypt } from "@bittery/shared/crypto";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import {
	Avatar,
	AvatarFallback,
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	toast,
} from "@bittery/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
	useNavigate,
	useParams,
} from "@tanstack/react-router";
import { LogOut, PlusIcon, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ItemForm } from "../../components/vault/item-form";
import { SearchCombobox } from "../../components/vault/search-combobox";

export const Route = createFileRoute("/vault")({
	component: RouteComponent,
	beforeLoad: async () => {
		// Check if user has stored credentials
		const hasSecretKey = await tauriStorage.hasStoredSecretKey();
		const sessionValid = await tauriStorage.isSessionValid();

		if (!hasSecretKey || !sessionValid) {
			await tauriStorage.clearAllStoredData();
			throw redirect({ to: "/login" });
		}

		const restored = await tauriStorage.tryRestoreSession(true);

		if (!restored) {
			throw redirect({ to: "/unlock" });
		}
	},
});

interface DecryptedItemData {
	title: string;
	url?: string;
	username?: string;
	password?: string;
	notes?: string;
	note?: string;
}

function RouteComponent() {
	const { data: vaultKeys } = useQuery({
		queryKey: ["vault-keys"],
		queryFn: async () => {
			const keys = await tauriStorage.getVaultKeys();
			return keys;
		},
	});

	const params = useParams({ strict: false });
	const navigate = useNavigate();
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();
	const trpc = useTRPC();

	const { data: user } = useQuery(trpc.auth.me.queryOptions());

	const [isNewItemDialogOpen, setIsNewItemDialogOpen] = useState(false);
	const [selectedCategory, setSelectedCategory] = useState<
		"login" | "secure-note"
	>("login");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleCreateItem = async (data: DecryptedItemData) => {
		if (!params.id) {
			toast.error("No vault selected");
			return;
		}

		setIsSubmitting(true);
		try {
			// Get vault key for encryption
			const vaultKey = await tauriStorage.getDecryptedVaultKey(params.id);

			if (!vaultKey) {
				throw new Error("No vault key found");
			}

			// Encrypt the item data
			const encryptedData = await encrypt(JSON.stringify(data), vaultKey);

			// Create overview
			const overview = {
				title: data.title || "Untitled",
				...(data.url && { url: data.url }),
				...(data.username && { username: data.username }),
			};

			const createdItem = await trpcClient.vault.createItem.mutate({
				vaultId: params.id,
				category: selectedCategory,
				overview,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
				encryptionAlgorithm: encryptedData.algorithm,
			});

			// Invalidate queries to refresh the list
			queryClient.invalidateQueries({ queryKey: [["vault", "listItems"]] });

			// Close dialog
			setIsNewItemDialogOpen(false);

			// Navigate to the newly created item
			navigate({
				to: "/vault/$id/$itemId",
				params: { id: params.id, itemId: createdItem.id },
			});

			toast.success("Item created successfully");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to create item";
			toast.error(errorMessage);
			throw error;
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleLogout = async () => {
		try {
			await tauriStorage.clearAllStoredData();
			navigate({ to: "/login" });
			toast.success("Logged out successfully");
		} catch (error) {
			console.error("Logout error:", error);
			toast.error("Failed to logout");
		}
	};

	return (
		<div className="flex h-screen flex-col overflow-hidden">
			{/* Top Header */}
			<header className="flex items-center justify-between border-b px-4 py-2">
				<div className="flex items-center gap-2">
					<div className="flex size-6 items-center justify-center rounded-sm bg-primary text-primary-foreground">
						<ShieldCheck className="size-4" />
					</div>
					<span className="font-bold text-xl tracking-tight">Bittery</span>
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="sm">
							<Avatar>
								<AvatarFallback>
									{user?.name
										?.split(" ")
										.map((n) => n[0])
										.join("")
										.toUpperCase()
										.slice(0, 2) || "U"}
								</AvatarFallback>
							</Avatar>
							<span className="text-sm">{user?.name || "User"}</span>
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuLabel>
							<div className="flex flex-col">
								<span className="font-medium">{user?.name || "User"}</span>
								<span className="text-muted-foreground text-xs">
									{user?.email}
								</span>
							</div>
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={handleLogout}>
							<LogOut className="mr-2 h-4 w-4" />
							Logout
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</header>

			{/* Main Content Area */}
			<div className="flex flex-1 overflow-hidden">
				{/* Left Sidebar - Vaults */}
				<div className="flex w-48 flex-col border-r bg-background">
					<div className="flex flex-1 flex-col overflow-y-auto p-2">
						{vaultKeys?.map((vault) => (
							<Link
								to="/vault/$id"
								params={{ id: vault.vaultId }}
								type="button"
								key={vault.vaultId}
								className={`mb-1 w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
									params.id === vault.vaultId
										? "bg-muted/60"
										: "hover:bg-muted/30"
								}`}
							>
								<div className="truncate">{vault.vaultName}</div>
							</Link>
						))}
					</div>
				</div>

				<div className="flex h-full flex-1 flex-col">
					<header>
						<div className="flex items-center space-x-3 border-b px-2 py-2.5">
							<div className="flex-1">
								<SearchCombobox />
							</div>
							<Button
								onClick={() => setIsNewItemDialogOpen(true)}
								disabled={!params.id}
							>
								<PlusIcon />
								New Item
							</Button>
						</div>
					</header>
					<div className="flex flex-1 overflow-hidden">
						<Outlet />
					</div>
				</div>
			</div>

			{/* New Item Dialog */}
			<Dialog open={isNewItemDialogOpen} onOpenChange={setIsNewItemDialogOpen}>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>Create New Item</DialogTitle>
						<DialogDescription>
							Choose a category and fill in the details for your new item.
						</DialogDescription>
					</DialogHeader>

					{/* Category Selection */}
					<div className="mb-4 flex gap-2">
						<Button
							type="button"
							variant={selectedCategory === "login" ? "default" : "outline"}
							onClick={() => setSelectedCategory("login")}
							className="flex-1"
						>
							Login
						</Button>
						<Button
							type="button"
							variant={
								selectedCategory === "secure-note" ? "default" : "outline"
							}
							onClick={() => setSelectedCategory("secure-note")}
							className="flex-1"
						>
							Secure Note
						</Button>
					</div>

					{/* Item Form */}
					<ItemForm
						category={selectedCategory}
						onSubmit={handleCreateItem}
						onCancel={() => setIsNewItemDialogOpen(false)}
						submitLabel="Create"
						isSubmitting={isSubmitting}
					/>
				</DialogContent>
			</Dialog>
		</div>
	);
}
