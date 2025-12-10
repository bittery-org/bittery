import {
  deriveClientSession,
  deriveKeys,
  generateClientEphemeral,
  getStoredSecretKey,
  getStoredSessionData,
  getTimeUntilExpiry,
  hasStoredSecretKey,
  isSessionValid,
  storeAuthToken,
  storeMasterUnlockKey,
  storeSecretKey,
  storeSessionData,
  storeVaultKeys,
  validateSecretKey,
  verifyServerSession,
} from "@bittery/shared/crypto";
import { useTRPCClient } from "@bittery/shared/trpc";
import { Button, Card, Input, Label, toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";

export default function SignInForm({
  onSwitchToSignUp,
}: {
  onSwitchToSignUp: () => void;
}) {
  const navigate = useNavigate();
  const trpcClient = useTRPCClient();
  const [_email, setEmail] = useState("");
  const [secretKeyHint, setSecretKeyHint] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [isQuickUnlock, setIsQuickUnlock] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
      secretKey: "",
    },
    onSubmit: async ({ value }) => {
      if (!validateSecretKey(value.secretKey)) {
        toast.error("Invalid Secret Key format");
        return;
      }
      await loginMutation.mutateAsync(value);
    },
  });

  // Check if quick unlock is available on mount
  useEffect(() => {
    if (hasStoredSecretKey()) {
      const storedSecretKey = getStoredSecretKey();
      const sessionData = getStoredSessionData();

      if (storedSecretKey && sessionData) {
        // Check if session is still valid
        if (isSessionValid()) {
          setIsQuickUnlock(true);
          setEmail(sessionData.email);
          form.setFieldValue("email", sessionData.email);
          form.setFieldValue("secretKey", storedSecretKey);
        } else {
          // Session expired, show message
          setSessionExpired(true);
          const timeExpired = Date.now() - sessionData.expiresAt;
          const daysExpired = Math.floor(timeExpired / (1000 * 60 * 60 * 24));
          toast.info(
            `Session expired ${
              daysExpired > 0 ? `${daysExpired} days ago` : "recently"
            }. Please sign in again.`
          );
        }
      }
    }
  }, [form.setFieldValue]);

  const loginMutation = useMutation({
    mutationFn: async (values: {
      email: string;
      password: string;
      secretKey: string;
    }) => {
      // 1. Derive keys from password + secret key
      const { authKey, masterUnlockKey } = await deriveKeys(
        values.password,
        values.secretKey,
        values.email
      );

      // Convert authKey to password string for SRP
      const password = new TextDecoder().decode(authKey);

      // 2. Generate client ephemeral key pair
      const clientEphemeral = generateClientEphemeral();

      // 3. Send client public key to server and get challenge
      const startResult = await trpcClient.auth.startLogin.mutate({
        email: values.email,
        clientPublicKey: clientEphemeral.publicKey,
      });

      // 4. Derive session and compute proof
      const clientSession = await deriveClientSession(
        clientEphemeral.secret,
        {
          salt: startResult.salt,
          serverPublicKey: startResult.serverPublicKey,
        },
        password
      );

      // 5. Send proof to server and get session
      const finishResult = await trpcClient.auth.finishLogin.mutate({
        userId: startResult.userId,
        serverSecret: startResult.serverSecret,
        clientPublicKey: clientEphemeral.publicKey,
        clientProof: clientSession.proof,
      });

      // 6. Verify server's proof (completes mutual authentication)
      await verifyServerSession(
        clientEphemeral.publicKey,
        clientSession,
        finishResult.serverProof
      );

      return { finishResult, masterUnlockKey };
    },
    onSuccess: async ({ finishResult, masterUnlockKey }, variables) => {
      // Store session data
      storeAuthToken(finishResult.token);
      storeVaultKeys(finishResult.vaultKeys);
      storeMasterUnlockKey(masterUnlockKey);

      // Store secret key and encrypted session for quick unlock
      storeSecretKey(variables.secretKey);
      await storeSessionData(
        masterUnlockKey,
        variables.email,
        finishResult.user.id
      );

      const timeUntil = getTimeUntilExpiry();
      const daysUntil = timeUntil
        ? Math.floor(timeUntil / (1000 * 60 * 60 * 24))
        : 0;

      toast.success(
        `Signed in successfully! Quick unlock available for ${daysUntil} days.`
      );
      navigate({ to: "/home" });
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to sign in");
    },
  });

  const checkEmailMutation = useMutation({
    mutationFn: async (input: { email: string }) => {
      return await trpcClient.auth.checkEmail.query(input);
    },
    onSuccess: (data) => {
      if (data.exists) {
        setSecretKeyHint(data.secretKeyHint);
      } else {
        toast.error("No account found with this email");
      }
    },
  });

  const handleEmailBlur = (email: string) => {
    if (email?.includes("@")) {
      setEmail(email);
      checkEmailMutation.mutate({ email });
    }
  };

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-col space-y-2 text-center">
        <h1 className="font-semibold text-xl tracking-tight">
          {isQuickUnlock ? "Welcome back" : "Sign in to your account"}
        </h1>
        <p className="text-muted-foreground text-sm">
          {isQuickUnlock
            ? "Enter your password to unlock profile"
            : "Enter your details below to access profile"}
        </p>
      </div>

      <Card className="border-0 bg-transparent p-8 shadow-none sm:border sm:bg-card sm:shadow-sm">
        {sessionExpired && (
          <div className="mb-6 rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900 dark:bg-yellow-950/30">
            <div className="flex gap-3">
              <div className="text-xl">⏱️</div>
              <div>
                <p className="font-medium text-sm text-yellow-900 dark:text-yellow-100">
                  Session Expired
                </p>
                <p className="mt-1 text-xs text-yellow-700 dark:text-yellow-300">
                  Your 14-day quick unlock period has ended. Please enter your
                  Secret Key to sign in.
                </p>
              </div>
            </div>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
          className="space-y-4"
        >
          <div>
            <form.Field name="email">
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor={field.name}>Email</Label>
                  <Input
                    id={field.name}
                    name={field.name}
                    type="email"
                    placeholder="name@example.com"
                    value={field.state.value}
                    onBlur={(e) => {
                      field.handleBlur();
                      handleEmailBlur(e.target.value);
                    }}
                    onChange={(e) => field.handleChange(e.target.value)}
                    required
                    disabled={isQuickUnlock}
                    className="h-10"
                  />
                </div>
              )}
            </form.Field>
          </div>

          {secretKeyHint && !isQuickUnlock && (
            <div className="rounded-md bg-muted px-3 py-2 text-muted-foreground text-xs">
              <span className="font-medium">Hint:</span> {secretKeyHint}
            </div>
          )}

          {!isQuickUnlock && (
            <div>
              <form.Field name="secretKey">
                {(field) => (
                  <div className="space-y-2">
                    <Label htmlFor={field.name}>Secret Key</Label>
                    <div className="relative">
                      <Input
                        id={field.name}
                        name={field.name}
                        type={showSecretKey ? "text" : "password"}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder="A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX"
                        required
                        className="h-10 pr-10 font-mono"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute top-0 right-0 h-10 w-10 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowSecretKey(!showSecretKey)}
                      >
                        {showSecretKey ? (
                          <EyeOff size={16} />
                        ) : (
                          <Eye size={16} />
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </form.Field>
            </div>
          )}

          <div>
            <form.Field name="password">
              {(field) => (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor={field.name}>Password</Label>
                  </div>
                  <div className="relative">
                    <Input
                      id={field.name}
                      name={field.name}
                      type={showPassword ? "text" : "password"}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      required
                      className="h-10 pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute top-0 right-0 h-10 w-10 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </Button>
                  </div>
                </div>
              )}
            </form.Field>
          </div>

          <Button
            type="submit"
            className="h-10 w-full font-medium"
            disabled={loginMutation.isPending}
          >
            {loginMutation.isPending
              ? "Signing In..."
              : isQuickUnlock
              ? "Unlock Vault"
              : "Sign In"}
          </Button>

          {isQuickUnlock && (
            <Button
              type="button"
              variant="link"
              onClick={() => {
                setIsQuickUnlock(false);
                form.setFieldValue("email", "");
                form.setFieldValue("secretKey", "");
              }}
              className="w-full text-muted-foreground"
            >
              Sign in with a different account
            </Button>
          )}

          {!isQuickUnlock && (
            <div className="mt-4 text-center text-muted-foreground text-sm">
              Don&apos;t have an account?{" "}
              <button
                type="button"
                onClick={onSwitchToSignUp}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Sign up
              </button>
            </div>
          )}
        </form>
      </Card>
    </div>
  );
}
