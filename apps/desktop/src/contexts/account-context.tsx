import type { IAutolockService } from "@bittery/types";
import { useQueryClient } from "@tanstack/react-query";
import type { Router } from "@tanstack/react-router";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { type AccountMetadata, storage } from "@/lib/storage";
import { createDesktopAutolockService } from "@/services/autolock-service";

interface AccountContextValue {
	activeAccount: AccountMetadata | null;
	allAccounts: AccountMetadata[];
	switchAccount: (email: string) => Promise<void>;
	addAccount: (account: AccountMetadata) => Promise<void>;
	removeAccount: (email: string) => Promise<void>;
	lockAccount: (email: string) => Promise<void>;
	lockAllAccounts: () => Promise<void>;
	refreshAccounts: () => Promise<void>;
	isLoading: boolean;
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({
	children,
	router,
}: {
	children: ReactNode;
	router: Router<any, any>;
}) {
	const [activeAccount, setActiveAccount] = useState<AccountMetadata | null>(
		null,
	);
	const [allAccounts, setAllAccounts] = useState<AccountMetadata[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const queryClient = useQueryClient();
	const autolockService = useRef<IAutolockService | null>(null);

	// Load accounts on mount
	const refreshAccounts = useCallback(async () => {
		try {
			const accountsList = await storage.getAccountsList();
			setAllAccounts(accountsList);

			const activeAccount = await storage.getActiveAccount();
			if (activeAccount?.type === "single") {
				const active = accountsList.find(
					(a) => a.email.toLowerCase() === activeAccount.email.toLowerCase(),
				);
				setActiveAccount(active ?? null);
			} else if (accountsList.length > 0) {
				// No active account set, use first one
				const firstAccount = accountsList[0];
				await storage.setActiveAccount({
					type: "single",
					email: firstAccount.email,
				});
				setActiveAccount(firstAccount);
			} else {
				setActiveAccount(null);
			}
		} catch (error) {
			console.error("[AccountContext] Failed to load accounts:", error);
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		refreshAccounts();
	}, [refreshAccounts]);

	const switchAccount = useCallback(
		async (email: string) => {
			const targetAccount = allAccounts.find(
				(a) => a.email.toLowerCase() === email.toLowerCase(),
			);
			if (!targetAccount) {
				throw new Error("Account not found");
			}

			// Check if target account session is valid
			const sessionValid = await storage.isSessionValid(email);

			// Clear current account's in-memory cache
			if (activeAccount) {
				await storage.clearSession(activeAccount.email);
			}

			// Set new active account
			await storage.setActiveAccount({ type: "single", email });
			setActiveAccount(targetAccount);

			// Invalidate all React Query queries to refetch with new account
			await queryClient.cancelQueries();
			queryClient.clear();

			// If session is not valid, the route guards will redirect to unlock
			if (!sessionValid) {
				// Session expired, will be handled by route guards
				return;
			}

			// Try to restore session for new account
			const restored = await storage.tryRestoreSession(true, email);
			if (!restored) {
				// Session restore failed, will be handled by route guards
				return;
			}
		},
		[activeAccount, allAccounts, queryClient],
	);

	const addAccount = useCallback(
		async (account: AccountMetadata) => {
			await storage.addAccountToList(account);
			await refreshAccounts();
		},
		[refreshAccounts],
	);

	const removeAccount = useCallback(
		async (email: string) => {
			const isActive =
				activeAccount?.email.toLowerCase() === email.toLowerCase();

			// Clear all data for this account
			await storage.clearAccountData(email);

			// Refresh accounts list
			await refreshAccounts();

			// If we removed the active account, switch to another if available
			if (isActive) {
				const accountsList = await storage.getAccountsList();
				if (accountsList.length > 0) {
					await switchAccount(accountsList[0].email);
				} else {
					setActiveAccount(null);
				}
			}
		},
		[activeAccount, refreshAccounts, switchAccount],
	);

	const lockAccount = useCallback(
		async (email: string) => {
			// Clear in-memory crypto materials for this account
			await storage.clearSession(email);

			// If locking active account, will need to re-authenticate
			if (activeAccount?.email.toLowerCase() === email.toLowerCase()) {
				await queryClient.cancelQueries();
				queryClient.clear();
			}
		},
		[activeAccount, queryClient],
	);

	const lockAllAccounts = useCallback(async () => {
		// Clear all in-memory caches and biometric auth timestamps
		await storage.lockAllAccounts();

		// Cancel and clear all queries
		await queryClient.cancelQueries();
		queryClient.clear();

		// Broadcast lock event to extension
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			await invoke("broadcast_lock_event", { reason: "manual" });
			console.log("[AccountContext] Broadcast lock event to extension");
		} catch (error) {
			console.error("[AccountContext] Failed to broadcast lock event:", error);
		}

		console.log("[AccountContext] All accounts locked");
	}, [queryClient]);

	// Initialize autolock service after lockAllAccounts is defined
	useEffect(() => {
		autolockService.current = createDesktopAutolockService(
			storage,
			lockAllAccounts,
		);
		autolockService.current.initialize();

		// Register callback to navigate to unlock when autolock triggers
		const unsubscribe = autolockService.current.onLock(() => {
			console.log("[AccountContext] Autolock triggered, navigating to unlock");
			router.navigate({ to: "/unlock" });
		});

		return () => {
			unsubscribe?.();
			autolockService.current?.dispose();
		};
	}, [lockAllAccounts, router]);

	// Listen for trigger-biometric-unlock event from extension (via desktop HTTP endpoint)
	useEffect(() => {
		let unlisten: (() => void) | undefined;

		const setupListener = async () => {
			try {
				const { listen } = await import("@tauri-apps/api/event");
				unlisten = await listen("trigger-biometric-unlock", () => {
					console.log(
						"[AccountContext] Received trigger-biometric-unlock event from extension",
					);
					// Navigate to unlock page with auto-trigger flag
					if (router) {
						router.navigate({
							to: "/unlock",
							search: {
								autoTrigger: true,
								autoTriggerId: Date.now().toString(),
							},
						});
					} else {
						console.error(
							"[AccountContext] Router not available for navigation",
						);
					}
				});
			} catch (error) {
				console.error(
					"[AccountContext] Failed to setup trigger-biometric-unlock listener:",
					error,
				);
			}
		};

		setupListener();

		return () => {
			if (unlisten) {
				unlisten();
			}
		};
	}, [router]);

	return (
		<AccountContext.Provider
			value={{
				activeAccount,
				allAccounts,
				switchAccount,
				addAccount,
				removeAccount,
				lockAccount,
				lockAllAccounts,
				refreshAccounts,
				isLoading,
			}}
		>
			{children}
		</AccountContext.Provider>
	);
}

export function useAccount(): AccountContextValue {
	const context = useContext(AccountContext);
	if (!context) {
		throw new Error("useAccount must be used within an AccountProvider");
	}
	return context;
}

export function useOptionalAccount(): AccountContextValue | null {
	return useContext(AccountContext);
}
