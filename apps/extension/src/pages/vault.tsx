import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Lock, Plus, Search } from "lucide-react";
import { useState } from "react";
import { Favicon } from "@/components/favicon";
import { Button } from "@bittery/ui";
import { Input } from "@bittery/ui";
import { Skeleton } from "@bittery/ui";

export function VaultPage() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");

  const { data: items, isLoading } = useQuery({
    queryKey: ["vault-items"],
    queryFn: async () => {
      const response = await chrome.runtime.sendMessage({
        type: "GET_VAULT_ITEMS",
      });
      return response.items || [];
    },
  });

  const filteredItems =
    items?.filter(
      (item: any) =>
        item.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.username?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.websiteUrl?.toLowerCase().includes(searchQuery.toLowerCase())
    ) || [];

  return (
    <div className="flex h-[400px] flex-col">
      <div className="border-b bg-background p-4">
        <div className="flex items-center justify-between mb-3">
          <h1 className="font-semibold text-lg">Vault</h1>
          <Button asChild size="icon" variant="ghost">
            <a href="http://localhost:3001" target="_blank" rel="noreferrer">
              <Plus size={18} />
            </a>
          </Button>
        </div>
        <div className="relative">
          <Search
            className="absolute top-2.5 left-3 text-muted-foreground"
            size={16}
          />
          <Input
            placeholder="Search vault..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col p-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="mb-1 h-[52px] w-full rounded-md" />
            ))}
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-8 text-center">
            <h3 className="mb-2 font-semibold">No items yet</h3>
            <p className="text-muted-foreground text-sm">
              {searchQuery ? "No items found" : "Create your first item"}
            </p>
          </div>
        ) : (
          <div className="flex flex-col p-2">
            {filteredItems.map((item: any) => (
              <button
                key={item.id}
                className="mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
                onClick={() => navigate({ to: `/item/${item.id}` })}
                type="button"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Favicon
                    url={item.websiteUrl}
                    title={item.title}
                    category="login"
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-sm">
                      {item.title}
                    </div>
                    {item.username && (
                      <div className="mt-0.5 truncate text-muted-foreground text-xs">
                        {item.username}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
