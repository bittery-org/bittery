import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useParams,
  useNavigate,
} from "@tanstack/react-router";
import { getVaultKeys, isAuthenticated, getDecryptedVaultKey, encrypt } from "@/lib/crypto";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";
import { SearchCombobox } from "@/components/vault/search-combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ItemForm } from "@/components/vault/item-form";
import { useState } from "react";
import { useTRPCClient } from "@/utils/trpc";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export const Route = createFileRoute("/vault")({
  component: RouteComponent,
  beforeLoad: () => {
    if (!isAuthenticated()) {
      throw redirect({ to: "/login" });
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
  const vaultKeys = getVaultKeys();
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  
  const [isNewItemDialogOpen, setIsNewItemDialogOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<"login" | "secure-note">("login");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreateItem = async (data: DecryptedItemData) => {
    if (!params.id) {
      toast.error("No vault selected");
      return;
    }

    setIsSubmitting(true);
    try {
      // Get vault key for encryption
      const vaultKey = await getDecryptedVaultKey(params.id);

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
      const errorMessage = error instanceof Error ? error.message : "Failed to create item";
      toast.error(errorMessage);
      throw error;
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left Sidebar - Vaults */}
      <div className="flex w-48 flex-col border-r bg-background">
        <div className="flex-1 overflow-y-auto p-2 flex flex-col">
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

      <div className="flex-1 h-full">
        <header>
          <div className="flex items-center space-x-3 border-b p-2">
            <div className="flex-1">
              <SearchCombobox />
            </div>
            <Button onClick={() => setIsNewItemDialogOpen(true)} disabled={!params.id}>
              <PlusIcon />
              New Item
            </Button>
          </div>
        </header>
        <div className="flex h-full">
          <Outlet />
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
          <div className="flex gap-2 mb-4">
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
              variant={selectedCategory === "secure-note" ? "default" : "outline"}
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
