import { Button, Card } from "@bittery/ui";
import { Lock, LogOut } from "lucide-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as tauriStorage from "@bittery/crypto/storage-tauri";

export const Route = createFileRoute("/_backup")({
  component: VaultPage,
});

export function VaultPage() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await tauriStorage.clearSession();
    navigate({ to: "/unlock" });
  };

  const handleFullLogout = async () => {
    await tauriStorage.clearAllStoredData();
    navigate({ to: "/login" });
  };
  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-white p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">Bittery</h1>
          <div className="flex gap-2">
            <Button onClick={handleLogout} variant="outline" size="sm">
              <Lock className="mr-2 h-4 w-4" />
              Lock
            </Button>
            <Button onClick={handleFullLogout} variant="outline" size="sm">
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center bg-gray-50 p-4">
        <Card className="max-w-md p-8 text-center">
          <h2 className="mb-4 text-2xl font-bold">Vault Unlocked</h2>
          <p className="text-gray-600">
            Your vault is now unlocked. Full vault UI coming soon...
          </p>
          <p className="mt-4 text-sm text-gray-500">
            The desktop app is now configured with biometric authentication!
          </p>
        </Card>
      </main>
    </div>
  );
}
