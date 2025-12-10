/**
 * Background Service Worker
 * Manages Master Unlock Key in memory, handles crypto operations,
 * proxies tRPC calls, and tracks autofill authentication state
 */

import type { AppRouter } from "@bittery/api/routers/index";
import {
	chromeStorage,
	decrypt,
	deriveClientSession,
	deriveKeys,
	generateClientEphemeral,
	verifyServerSession,
} from "@bittery/crypto";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

console.log("Bittery background service worker loaded");

// In-memory state
let masterUnlockKey: Uint8Array | null = null;
let lastActivityTimestamp = 0;
let autoLockTimer: NodeJS.Timeout | null = null;
const AUTO_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const AUTOFILL_REAUTH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes (separate for autofill security)
const KEEPALIVE_INTERVAL_MS = 20 * 1000; // 20 seconds (well before 30s service worker timeout)
const AUTO_LOCK_ALARM_NAME = "autoLockAlarm";

// Keepalive mechanism to prevent service worker from shutting down
let keepaliveInterval: NodeJS.Timeout | null = null;

// tRPC client for API calls
const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: "http://localhost:3000/trpc", // TODO: Make configurable
			async headers() {
				const token = await chromeStorage.getAuthToken();
				return {
					authorization: token ? `Bearer ${token}` : "",
				};
			},
		}),
	],
});

// Auto-lock functions
function updateActivity() {
	lastActivityTimestamp = Date.now();
	resetAutoLockTimer();
}

function resetAutoLockTimer() {
	// Clear existing timeout
	if (autoLockTimer) {
		clearTimeout(autoLockTimer);
	}

	// Use setTimeout for in-memory timer
	autoLockTimer = setTimeout(() => {
		console.log("Auto-locking due to inactivity");
		lock();
	}, AUTO_LOCK_TIMEOUT_MS);

	// Also set Chrome Alarm as backup (survives service worker restarts)
	chrome.alarms.create(AUTO_LOCK_ALARM_NAME, {
		delayInMinutes: AUTO_LOCK_TIMEOUT_MS / 60000,
	});

	// Start keepalive when there's active session
	startKeepalive();
}

function startKeepalive() {
	if (keepaliveInterval) return; // Already running

	console.log("Starting service worker keepalive");
	keepaliveInterval = setInterval(() => {
		// Simple no-op to keep service worker alive
		// Could also use chrome.runtime.getPlatformInfo() or similar
		console.debug("Keepalive ping");
	}, KEEPALIVE_INTERVAL_MS);
}

function stopKeepalive() {
	if (keepaliveInterval) {
		clearInterval(keepaliveInterval);
		keepaliveInterval = null;
		console.log("Stopped service worker keepalive");
	}
}

function lock() {
	masterUnlockKey = null;
	lastActivityTimestamp = 0;
	if (autoLockTimer) {
		clearTimeout(autoLockTimer);
		autoLockTimer = null;
	}
	// Clear the Chrome alarm
	chrome.alarms.clear(AUTO_LOCK_ALARM_NAME);
	stopKeepalive();
	console.log("Extension locked");
}

function isUnlocked(): boolean {
	if (!masterUnlockKey) return false;

	const now = Date.now();
	const timeSinceLastActivity = now - lastActivityTimestamp;

	if (timeSinceLastActivity > AUTO_LOCK_TIMEOUT_MS) {
		lock();
		return false;
	}

	return true;
}

// Message handler
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	console.log("Background received message:", message.type);

	// Handle async operations
	(async () => {
		try {
			switch (message.type) {
				case "LOGIN": {
					const { email, password, secretKey } = message.payload;

					// 1. Derive keys from password + secret key
					const { authKey, masterUnlockKey: muk } = await deriveKeys(
						password,
						secretKey,
						email,
					);

					// Convert authKey to password string for SRP
					const srpPassword = new TextDecoder().decode(authKey);

					// 2. Generate client ephemeral key pair
					const clientEphemeral = generateClientEphemeral();

					// 3. Send client public key to server and get challenge
					const startResult = await trpcClient.auth.startLogin.mutate({
						email,
						clientPublicKey: clientEphemeral.publicKey,
					});

					// 4. Derive session and compute proof
					const clientSession = await deriveClientSession(
						clientEphemeral.secret,
						{
							salt: startResult.salt,
							serverPublicKey: startResult.serverPublicKey,
						},
						srpPassword,
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
						finishResult.serverProof,
					);

					// Store session data
					await chromeStorage.storeAuthToken(finishResult.token);
					await chromeStorage.storeVaultKeys(finishResult.vaultKeys);
					chromeStorage.storeMasterUnlockKey(muk);
					masterUnlockKey = muk;

					// Store secret key and encrypted session for quick unlock
					await chromeStorage.storeSecretKey(secretKey);
					await chromeStorage.storeSessionData(
						muk,
						email,
						finishResult.user.id,
					);

					// Start activity tracking
					updateActivity();

					sendResponse({ success: true });
					break;
				}

				case "QUICK_UNLOCK": {
					const { password } = message.payload;

					// Get stored secret key and session data
					const secretKey = await chromeStorage.getStoredSecretKey();
					const sessionData = await chromeStorage.getStoredSessionData();

					if (!secretKey || !sessionData) {
						throw new Error("Quick unlock not available");
					}

					// Derive keys and unlock
					const { authKey, masterUnlockKey: muk } = await deriveKeys(
						password,
						secretKey,
						sessionData.email,
					);

					// Convert authKey to password string for SRP
					const srpPassword = new TextDecoder().decode(authKey);

					// Generate client ephemeral key pair
					const clientEphemeral = generateClientEphemeral();

					// Send client public key to server and get challenge
					const startResult = await trpcClient.auth.startLogin.mutate({
						email: sessionData.email,
						clientPublicKey: clientEphemeral.publicKey,
					});

					// Derive session and compute proof
					const clientSession = await deriveClientSession(
						clientEphemeral.secret,
						{
							salt: startResult.salt,
							serverPublicKey: startResult.serverPublicKey,
						},
						srpPassword,
					);

					// Send proof to server and get vault keys
					const finishResult = await trpcClient.auth.finishLogin.mutate({
						userId: startResult.userId,
						serverSecret: startResult.serverSecret,
						clientPublicKey: clientEphemeral.publicKey,
						clientProof: clientSession.proof,
					});

					// Verify server's proof
					await verifyServerSession(
						clientEphemeral.publicKey,
						clientSession,
						finishResult.serverProof,
					);

					// Store session data and vault keys
					await chromeStorage.storeAuthToken(finishResult.token);
					await chromeStorage.storeVaultKeys(finishResult.vaultKeys);
					chromeStorage.storeMasterUnlockKey(muk);
					masterUnlockKey = muk;

					// Start activity tracking
					updateActivity();

					sendResponse({ success: true });
					break;
				}

				case "CHECK_AUTH": {
					// Check if we have a valid session and MUK is still in memory
					const authenticated = await chromeStorage.isAuthenticated();
					const unlocked = isUnlocked();

					if (authenticated) {
						updateActivity();
					}

					sendResponse({ authenticated, unlocked });
					break;
				}

				case "CAN_QUICK_UNLOCK": {
					const canQuickUnlock = await chromeStorage.canQuickUnlock();
					sendResponse({ canQuickUnlock });
					break;
				}

				case "GET_AUTH_TOKEN": {
					const token = await chromeStorage.getAuthToken();
					sendResponse({ token });
					break;
				}

				case "GET_SESSION_DATA": {
					const sessionData = await chromeStorage.getStoredSessionData();
					sendResponse({ sessionData });
					break;
				}

				case "GET_VAULT_ITEMS": {
					// Update activity timestamp
					updateActivity();

					// Get vault keys and decrypt items
					const vaultKeys = await chromeStorage.getVaultKeys();

					if (!vaultKeys || vaultKeys.length === 0) {
						sendResponse({ items: [] });
						break;
					}

					const vaults = await trpcClient.vault.list.query();

					const decryptedVaultKeys: Record<string, Uint8Array> = {};

					await Promise.all(
						vaultKeys.map(async (vk) => {
							decryptedVaultKeys[vk.vaultId] =
								await chromeStorage.decryptVaultKey(vk.encryptedVaultKey);
						}),
					);

					const allVaultItems = await Promise.all(
						vaults.map(async (vault) => {
							try {
								const decryptedItems = await Promise.all(
									vault.items.map(async (item) => {
										try {
											const vaultKey = decryptedVaultKeys[vault.id];
											if (!vaultKey) throw new Error("Vault key not found");

											const decrypted = await decrypt(
												{
													algorithm: item.encryptionAlgorithm,
													iv: item.encryptionIv,
													ciphertext: item.encryptedData,
												},
												vaultKey!,
											);

											const data = JSON.parse(decrypted);
											return { ...item, ...data };
										} catch (error) {
											console.error("Failed to decrypt item:", item.id, error);
											return null;
										}
									}),
								);

								return decryptedItems.filter((item) => item !== null);
							} catch (_error) {
								console.log(_error);
								return [];
							}
						}),
					);

					// Flatten the array of arrays
					const items = allVaultItems.flat();

					sendResponse({
						items: items,
					});

					break;
				}

				case "GET_VAULT_ITEM": {
					// Update activity timestamp
					updateActivity();

					const { itemId } = message.payload;

					// Get vault keys
					const vaultKeys = await chromeStorage.getVaultKeys();
					if (!vaultKeys || vaultKeys.length === 0) {
						sendResponse({ item: null });
						break;
					}

					// Get item
					const item = await trpcClient.vault.getItem.query({ itemId });

					if (!item) {
						sendResponse({ item: null });
						break;
					}

					// Find vault key for this item
					const vaultKeyData = vaultKeys.find(
						(vk) => vk.vaultId === item.vaultId,
					);
					if (!vaultKeyData) {
						sendResponse({ item: null });
						break;
					}

					// Decrypt item
					const vaultKey = await chromeStorage.decryptVaultKey(
						vaultKeyData.encryptedVaultKey,
					);

					const decrypted = await decrypt(
						{
							algorithm: item.encryptionAlgorithm,
							iv: item.encryptionIv,
							ciphertext: item.encryptedData,
						},
						vaultKey,
					);

					const data = JSON.parse(decrypted);

					sendResponse({ item: { ...item, ...data } });
					break;
				}

				case "CHECK_AUTOFILL_AUTH": {
					// Check if extension is unlocked and if user needs to re-auth for autofill
					const unlocked = isUnlocked();

					if (!unlocked) {
						sendResponse({ authenticated: false, unlocked: false });
						break;
					}

					// Additional check: autofill requires more frequent re-auth
					const now = Date.now();
					const timeSinceLastActivity = now - lastActivityTimestamp;
					const needsReauth = timeSinceLastActivity > AUTOFILL_REAUTH_WINDOW_MS;

					if (needsReauth) {
						sendResponse({
							authenticated: false,
							unlocked: true,
							needsReauth: true,
						});
					} else {
						const authenticated = await chromeStorage.isAuthenticated();
						sendResponse({ authenticated, unlocked: true, needsReauth: false });
					}
					break;
				}

				case "UPDATE_AUTOFILL_TIMESTAMP": {
					// Autofill activity also counts as general activity
					updateActivity();
					sendResponse({ success: true });
					break;
				}

				case "GET_AUTOFILL_ITEMS": {
					// Update activity timestamp
					updateActivity();

					const { hostname } = message.payload;

					// Update activity timestamp
					updateActivity();

					// Get vault keys and decrypt items
					const vaultKeys = await chromeStorage.getVaultKeys();

					if (!vaultKeys || vaultKeys.length === 0) {
						sendResponse({ items: [] });
						break;
					}

					const vaults = await trpcClient.vault.list.query();

					const decryptedVaultKeys: Record<string, Uint8Array> = {};

					await Promise.all(
						vaultKeys.map(async (vk) => {
							decryptedVaultKeys[vk.vaultId] =
								await chromeStorage.decryptVaultKey(vk.encryptedVaultKey);
						}),
					);

					const allVaultItems = await Promise.all(
						vaults.map(async (vault) => {
							try {
								const decryptedItems = await Promise.all(
									vault.items.map(async (item) => {
										try {
											const vaultKey = decryptedVaultKeys[vault.id];
											if (!vaultKey) throw new Error("Vault key not found");

											const decrypted = await decrypt(
												{
													algorithm: item.encryptionAlgorithm,
													iv: item.encryptionIv,
													ciphertext: item.encryptedData,
												},
												vaultKey!,
											);

											const data = JSON.parse(decrypted);
											return { ...item, ...data };
										} catch (error) {
											console.error("Failed to decrypt item:", item.id, error);
											return null;
										}
									}),
								);

								return decryptedItems.filter((item) => item !== null);
							} catch (_error) {
								console.log(_error);
								return [];
							}
						}),
					);

					// Flatten the array of arrays
					const items = allVaultItems.flat();

					console.log(items);

					// Filter by hostname
					const filtered = items.filter((item) => {
						if (!item?.overview.url) return false;
						try {
							const itemUrl = new URL(
								item.overview.url.startsWith("http")
									? item.overview.url
									: `https://${item.overview.url}`,
							);

							const itemHostname = itemUrl.hostname;

							// Exact match
							if (itemHostname === hostname) return true;

							// Check if one is a subdomain of the other
							// e.g., "app.example.com" should match "example.com" and vice versa
							if (
								itemHostname.endsWith(`.${hostname}`) ||
								hostname.endsWith(`.${itemHostname}`)
							) {
								return true;
							}

							// Extract base domain (remove subdomains)
							// e.g., "app.example.com" -> "example.com"
							const getBaseDomain = (host: string) => {
								const parts = host.split(".");
								if (parts.length <= 2) return host;
								return parts.slice(-2).join(".");
							};

							const itemBaseDomain = getBaseDomain(itemHostname);
							const hostnameBaseDomain = getBaseDomain(hostname);

							return itemBaseDomain === hostnameBaseDomain;
						} catch {
							return false;
						}
					});

					sendResponse({ items: filtered });

					break;
				}

				case "LOGOUT": {
					await chromeStorage.clearSession();
					lock();
					sendResponse({ success: true });
					break;
				}

				case "LOCK": {
					// Manual lock - clears MUK from memory but keeps vault keys in storage
					lock();
					sendResponse({ success: true });
					break;
				}

				default:
					sendResponse({ success: false, error: "Unknown message type" });
			}
		} catch (error) {
			console.error("Background error:", error);
			sendResponse({ success: false, error: String(error) });
		}
	})();

	return true; // Keep channel open for async response
});

// Handle Chrome Alarms for auto-lock
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === AUTO_LOCK_ALARM_NAME) {
		console.log("Auto-lock alarm triggered");
		// Check if we should still lock (in case service worker was restarted)
		if (isUnlocked()) {
			const now = Date.now();
			const timeSinceLastActivity = now - lastActivityTimestamp;

			if (timeSinceLastActivity >= AUTO_LOCK_TIMEOUT_MS) {
				lock();
			} else {
				// Reschedule if there was recent activity
				const remainingTime = AUTO_LOCK_TIMEOUT_MS - timeSinceLastActivity;
				chrome.alarms.create(AUTO_LOCK_ALARM_NAME, {
					delayInMinutes: remainingTime / 60000,
				});
			}
		}
	}
});

// Keep service worker alive
chrome.runtime.onStartup.addListener(() => {
	console.log("Extension started");
});

chrome.runtime.onInstalled.addListener(() => {
	console.log("Extension installed");
});
