import { useState, useEffect } from "react";
import { Button, Card, Input, Label, toast } from "@bittery/ui";
import * as tauriStorage from "@bittery/crypto/storage-tauri";
import {
  deriveKeys,
  generateClientEphemeral,
  deriveClientSession,
  verifyServerSession,
} from "@bittery/crypto";
import { Fingerprint, Lock } from "lucide-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTRPCClient } from "@bittery/shared/trpc";
import { useQuery } from "@tanstack/react-query";

export const Route = createFileRoute("/unlock")({
  component: UnlockPage,
});

export function UnlockPage() {
  const trpcClient = useTRPCClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const { data: sessionState } = useQuery({
    queryKey: ["biometry-status"],
    queryFn: async () => {
      const available = await tauriStorage.isBiometricAvailable();
      const storedData = await tauriStorage.getStoredSessionData();

      return {
        available,
        enabled: storedData?.biometricEnabled ?? false,
        data: storedData,
      };
    },
  });

  const handleBiometricUnlock = async () => {
    setLoading(true);
    try {
      const success = await tauriStorage.unlockWithBiometric();
      if (success) {
        // Restore auth token and vault keys
        const token = await tauriStorage.getAuthToken();
        const vaultKeys = await tauriStorage.getVaultKeys();

        if (token && vaultKeys) {
          toast.success("Unlocked with biometric");
          navigate({ to: "/vault" });
        } else {
          toast.error("Session data missing, please log in again");
          await tauriStorage.clearAllStoredData();
          navigate({ to: "/login" });
        }
      } else {
        toast.error("Biometric authentication failed");
      }
    } catch (error) {
      console.error("Biometric unlock error:", error);
      toast.error("Biometric unlock failed");
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const secretKey = await tauriStorage.getStoredSecretKey();
      if (!secretKey) {
        toast.error("Secret key not found. Please log in again.");
        await tauriStorage.clearAllStoredData();
        navigate({ to: "/login" });
        return;
      }

      if (!sessionState?.data) {
        toast.error("Session data not found. Please log in again.");
        await tauriStorage.clearAllStoredData();
        navigate({ to: "/login" });
        return;
      }

      // 1. Derive keys from password + secret key
      const { authKey, masterUnlockKey } = await deriveKeys(
        password,
        secretKey,
        sessionState.data.email
      );

      // Convert authKey to password string for SRP
      const srpPassword = new TextDecoder().decode(authKey);

      // 2. Generate client ephemeral key pair
      const clientEphemeral = generateClientEphemeral();

      // 3. Send client public key to server and get challenge
      const startResult = await trpcClient.auth.startLogin.mutate({
        email: sessionState.data.email,
        clientPublicKey: clientEphemeral.publicKey,
      });

      // 4. Derive session and compute proof
      const clientSession = await deriveClientSession(
        clientEphemeral.secret,
        {
          salt: startResult.salt,
          serverPublicKey: startResult.serverPublicKey,
        },
        srpPassword
      );

      // 5. Send proof to server and get session
      const finishResult = await trpcClient.auth.finishLogin.mutate({
        userId: startResult.userId,
        serverSecret: startResult.serverSecret,
        clientPublicKey: clientEphemeral.publicKey,
        clientProof: clientSession.proof,
      });

      if (!finishResult.serverProof) {
        toast.error("Unlock failed");
        setLoading(false);
        return;
      }

      // 6. Verify server's proof (completes mutual authentication)
      await verifyServerSession(
        clientEphemeral.publicKey,
        clientSession,
        finishResult.serverProof
      );

      // Update session with fresh data
      await tauriStorage.storeAuthToken(finishResult.token);
      await tauriStorage.storeVaultKeys(finishResult.vaultKeys);
      await tauriStorage.storeSessionData(
        masterUnlockKey,
        sessionState.data.email,
        finishResult.user.id
      );
      tauriStorage.storeMasterUnlockKey(masterUnlockKey);

      toast.success("Vault unlocked");
      navigate({ to: "/vault" });
    } catch (error) {
      console.error("Unlock error:", error);
      toast.error(error instanceof Error ? error.message : "Unlock failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-md p-6">
        <div className="mb-6 text-center">
          <Lock className="mx-auto h-12 w-12 text-gray-400" />
          <h1 className="mt-4 text-2xl font-bold">Unlock Bittery</h1>
          {sessionState?.data && (
            <p className="text-sm text-gray-600">{sessionState.data.email}</p>
          )}
        </div>

        {sessionState?.available && sessionState?.enabled && (
          <div className="mb-4">
            <Button
              type="button"
              onClick={handleBiometricUnlock}
              className="w-full"
              variant="outline"
              disabled={loading}
            >
              <Fingerprint className="mr-2 h-4 w-4" />
              {loading ? "Authenticating..." : "Unlock with Biometric"}
            </Button>
            <div className="my-4 text-center text-sm text-gray-500">or</div>
          </div>
        )}

        <form onSubmit={handlePasswordUnlock} className="space-y-4">
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Enter your password"
              autoFocus
            />
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Unlocking..." : "Unlock"}
          </Button>
        </form>

        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={async () => {
              await tauriStorage.clearAllStoredData();
              navigate({ to: "/login" });
            }}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            Sign in with different account
          </button>
        </div>
      </Card>
    </div>
  );
}
