/**
 * Background Service Worker
 * Manages Master Unlock Key in memory, handles crypto operations,
 * proxies tRPC calls, and tracks autofill authentication state
 */

import type { AppRouter } from "@bittery/api/routers/index";
import {
	buildTrpcUrl,
	chromeStorage,
	decrypt,
	deriveClientSession,
	deriveKeys,
	encrypt,
	generateClientEphemeral,
	normalizeServerUrl,
	verifyServerSession,
} from "@bittery/crypto";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

console.log("Bittery background service worker loaded");

// Native messaging host name
const NATIVE_HOST_NAME = "com.bittery.desktop";

// In-memory state
let masterUnlockKey: Uint8Array | null = null;
let lastActivityTimestamp = 0;
let autoLockTimer: NodeJS.Timeout | null = null;
const AUTO_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const AUTOFILL_REAUTH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes (separate for autofill security)
const KEEPALIVE_INTERVAL_MS = 20 * 1000; // 20 seconds (well before 30s service worker timeout)
const AUTO_LOCK_ALARM_NAME = "autoLockAlarm";
const fallbackServerUrl =
	normalizeServerUrl("http://localhost:3000") ?? "http://localhost:3000";

// Keepalive mechanism to prevent service worker from shutting down
let keepaliveInterval: NodeJS.Timeout | null = null;

// tRPC client for API calls
const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${fallbackServerUrl}/trpc`,
			async headers() {
				const token = await chromeStorage.getAuthToken();
				return {
					authorization: token ? `Bearer ${token}` : "",
				};
			},
			async fetch(url, options) {
				const storedServerUrl = await chromeStorage.getServerUrl();
				const serverUrl = storedServerUrl ?? fallbackServerUrl;
				const resolvedUrl = buildTrpcUrl(serverUrl, url);
				return fetch(resolvedUrl, options);
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

/**
 * Send a message to the native messaging host
 * Returns a promise that resolves with the response
 */
function sendNativeMessage(message: unknown): Promise<unknown> {
	console.log("[Native Messaging] Attempting to connect to:", NATIVE_HOST_NAME);
	console.log("[Native Messaging] Sending message:", message);

	return new Promise((resolve, reject) => {
		try {
			const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
			console.log("[Native Messaging] Port connected successfully");

			const timeout = setTimeout(() => {
				console.error("[Native Messaging] Timeout after 30 seconds");
				port.disconnect();
				reject(new Error("Native messaging timeout"));
			}, 30000); // 30 second timeout

			port.onMessage.addListener((response) => {
				console.log("[Native Messaging] Received response:", response);
				clearTimeout(timeout);
				port.disconnect();
				resolve(response);
			});

			port.onDisconnect.addListener(() => {
				console.log("[Native Messaging] Port disconnected");
				clearTimeout(timeout);
				const error = chrome.runtime.lastError;
				if (error) {
					console.error("[Native Messaging] Disconnect error:", error);
					reject(
						new Error(
							`Native host disconnected: ${error.message || "Unknown error"}`,
						),
					);
				} else {
					console.error("[Native Messaging] Disconnect without error");
					reject(new Error("Native host disconnected"));
				}
			});

			port.postMessage(message);
			console.log("[Native Messaging] Message posted to port");
		} catch (error) {
			console.error("[Native Messaging] Exception during connection:", error);
			reject(error);
		}
	});
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

				case "TOGGLE_FAVORITE": {
					// Update activity timestamp
					updateActivity();

					const { itemId, favorite } = message.payload;

					// Toggle favorite via tRPC
					await trpcClient.vault.toggleFavorite.mutate({ itemId, favorite });

					sendResponse({ success: true });
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

				case "GET_WRITABLE_VAULTS": {
					// Update activity timestamp
					updateActivity();

					// Fetch all vaults
					const vaults = await trpcClient.vault.list.query();

					// Filter out read-only vaults (only return vaults user can write to)
					const writableVaults = vaults.filter(
						(vault) => vault.role !== "read-only",
					);

					sendResponse({
						success: true,
						vaults: writableVaults.map((v) => ({
							id: v.id,
							name: v.name,
							type: v.type,
							role: v.role,
						})),
					});
					break;
				}

				case "CHECK_EXISTING_CREDENTIALS": {
					// Update activity timestamp
					updateActivity();

					const { url, username } = message.payload;

					if (!url) {
						sendResponse({
							success: false,
							error: "URL is required",
						});
						break;
					}

					// Extract hostname from URL
					let hostname: string;
					try {
						const urlObj = new URL(
							url.startsWith("http") ? url : `https://${url}`,
						);
						hostname = urlObj.hostname;
					} catch {
						sendResponse({
							success: false,
							error: "Invalid URL",
						});
						break;
					}

					// Get vault keys and decrypt items (same pattern as GET_AUTOFILL_ITEMS)
					const vaultKeys = await chromeStorage.getVaultKeys();

					if (!vaultKeys || vaultKeys.length === 0) {
						sendResponse({
							success: true,
							existingCredentials: [],
							hasDuplicates: false,
						});
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

					// Filter by hostname (same logic as GET_AUTOFILL_ITEMS)
					const matchingItems = items.filter((item) => {
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
							if (
								itemHostname.endsWith(`.${hostname}`) ||
								hostname.endsWith(`.${itemHostname}`)
							) {
								return true;
							}

							// Extract base domain (remove subdomains)
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

					// If username is provided, filter further to find exact username matches
					let exactMatches = matchingItems;
					if (username) {
						exactMatches = matchingItems.filter(
							(item) => item.username?.toLowerCase() === username.toLowerCase(),
						);
					}

					sendResponse({
						success: true,
						existingCredentials: exactMatches.map((item) => ({
							id: item.id,
							vaultId: item.vaultId,
							username: item.username || "",
							url: item.overview.url || "",
						})),
						hasDuplicates: exactMatches.length > 0,
					});

					break;
				}

				case "SAVE_NEW_CREDENTIAL": {
					// Update activity timestamp
					updateActivity();

					const { vaultId, username, password, url } = message.payload;

					// Validate inputs
					if (!vaultId || !username || !password || !url) {
						sendResponse({
							success: false,
							error: "Missing required fields",
							errorType: "validation",
						});
						break;
					}

					// Check if extension is still unlocked
					if (!isUnlocked()) {
						sendResponse({
							success: false,
							error: "Extension is locked. Please unlock and try again.",
							errorType: "locked",
						});
						break;
					}

					// Get vault key for the selected vault
					const vaultKeys = await chromeStorage.getVaultKeys();
					if (!vaultKeys || vaultKeys.length === 0) {
						sendResponse({
							success: false,
							error: "No vault keys available. Please re-authenticate.",
							errorType: "vault_key",
						});
						break;
					}

					const vaultKeyData = vaultKeys.find((vk) => vk.vaultId === vaultId);
					if (!vaultKeyData) {
						sendResponse({
							success: false,
							error: "Vault key not found. Please select a different vault.",
							errorType: "vault_key",
						});
						break;
					}

					try {
						// Decrypt vault key
						const vaultKey = await chromeStorage.decryptVaultKey(
							vaultKeyData.encryptedVaultKey,
						);

						// Prepare credential data to encrypt
						const credentialData = {
							username,
							password,
							overview: {
								url,
							},
						};

						// Encrypt credential data with vault key
						const encryptedData = await encrypt(
							JSON.stringify(credentialData),
							vaultKey,
						);

						// Extract hostname from URL for title
						let hostname = url;
						try {
							const urlObj = new URL(
								url.startsWith("http") ? url : `https://${url}`,
							);
							hostname = urlObj.hostname;
						} catch {
							// Use URL as-is if parsing fails
						}

						// Create item via tRPC
						const result = await trpcClient.vault.createItem.mutate({
							vaultId,
							category: "login",
							overview: {
								title: hostname,
								url,
								username,
							},
							encryptedData: encryptedData.ciphertext,
							encryptionIv: encryptedData.iv,
							encryptionAlgorithm: encryptedData.algorithm,
						});

						sendResponse({ success: true, itemId: result.itemId });
					} catch (error: any) {
						console.error("Error saving credential:", error);

						// Determine error type and message
						let errorMessage = "Failed to save credentials. Please try again.";
						let errorType = "unknown";

						if (
							error.message?.includes("network") ||
							error.message?.includes("fetch")
						) {
							errorMessage =
								"Network error. Check your connection and try again.";
							errorType = "network";
						} else if (
							error.message?.includes("decrypt") ||
							error.message?.includes("encryption")
						) {
							errorMessage = "Encryption error. Please unlock and try again.";
							errorType = "encryption";
						} else if (
							error.message?.includes("unauthorized") ||
							error.message?.includes("auth")
						) {
							errorMessage = "Authentication error. Please re-authenticate.";
							errorType = "auth";
						} else if (
							error.message?.includes("permission") ||
							error.message?.includes("access")
						) {
							errorMessage =
								"Permission denied. You may not have write access to this vault.";
							errorType = "permission";
						}

						sendResponse({
							success: false,
							error: errorMessage,
							errorType,
						});
					}
					break;
				}

				case "UPDATE_EXISTING_CREDENTIAL": {
					// Update activity timestamp
					updateActivity();

					const { itemId, vaultId, username, password, url } = message.payload;

					// Validate inputs
					if (!itemId || !vaultId || !username || !password || !url) {
						sendResponse({
							success: false,
							error: "Missing required fields",
							errorType: "validation",
						});
						break;
					}

					// Check if extension is still unlocked
					if (!isUnlocked()) {
						sendResponse({
							success: false,
							error: "Extension is locked. Please unlock and try again.",
							errorType: "locked",
						});
						break;
					}

					// Get vault key for the selected vault
					const vaultKeys = await chromeStorage.getVaultKeys();
					if (!vaultKeys || vaultKeys.length === 0) {
						sendResponse({
							success: false,
							error: "No vault keys available. Please re-authenticate.",
							errorType: "vault_key",
						});
						break;
					}

					const vaultKeyData = vaultKeys.find((vk) => vk.vaultId === vaultId);
					if (!vaultKeyData) {
						sendResponse({
							success: false,
							error: "Vault key not found. Please select a different vault.",
							errorType: "vault_key",
						});
						break;
					}

					try {
						// Decrypt vault key
						const vaultKey = await chromeStorage.decryptVaultKey(
							vaultKeyData.encryptedVaultKey,
						);

						// Prepare credential data to encrypt
						const credentialData = {
							username,
							password,
							overview: {
								url,
							},
						};

						// Encrypt credential data with vault key
						const encryptedData = await encrypt(
							JSON.stringify(credentialData),
							vaultKey,
						);

						// Extract hostname from URL for title
						let hostname = url;
						try {
							const urlObj = new URL(
								url.startsWith("http") ? url : `https://${url}`,
							);
							hostname = urlObj.hostname;
						} catch {
							// Use URL as-is if parsing fails
						}

						// Update item via tRPC
						await trpcClient.vault.updateItem.mutate({
							itemId,
							overview: {
								title: hostname,
								url,
								username,
							},
							encryptedData: encryptedData.ciphertext,
							encryptionIv: encryptedData.iv,
							encryptionAlgorithm: encryptedData.algorithm,
						});

						sendResponse({ success: true });
					} catch (error: any) {
						console.error("Error updating credential:", error);

						// Determine error type and message
						let errorMessage =
							"Failed to update credentials. Please try again.";
						let errorType = "unknown";

						if (
							error.message?.includes("network") ||
							error.message?.includes("fetch")
						) {
							errorMessage =
								"Network error. Check your connection and try again.";
							errorType = "network";
						} else if (
							error.message?.includes("decrypt") ||
							error.message?.includes("encryption")
						) {
							errorMessage = "Encryption error. Please unlock and try again.";
							errorType = "encryption";
						} else if (
							error.message?.includes("unauthorized") ||
							error.message?.includes("auth")
						) {
							errorMessage = "Authentication error. Please re-authenticate.";
							errorType = "auth";
						} else if (
							error.message?.includes("permission") ||
							error.message?.includes("access")
						) {
							errorMessage =
								"Permission denied. You may not have write access to this vault.";
							errorType = "permission";
						} else if (error.message?.includes("not found")) {
							errorMessage = "Credential not found. It may have been deleted.";
							errorType = "not_found";
						}

						sendResponse({
							success: false,
							error: errorMessage,
							errorType,
						});
					}
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

				case "CHECK_NATIVE_BIOMETRIC": {
					// Check if native messaging host is available
					console.log(
						"[CHECK_NATIVE_BIOMETRIC] Starting biometric availability check",
					);
					try {
						const response = await sendNativeMessage({
							type: "CHECK_BIOMETRIC_AVAILABLE",
						});

						console.log(
							"[CHECK_NATIVE_BIOMETRIC] Processing response:",
							response,
						);
						const responseData = response as any;
						const result = {
							available:
								responseData?.type === "BIOMETRIC_STATUS" &&
								responseData.available,
							enabled: responseData?.enabled || false,
							appRunning: responseData?.app_running || false,
						};
						console.log("[CHECK_NATIVE_BIOMETRIC] Sending result:", result);
						sendResponse(result);
					} catch (error) {
						console.error("[CHECK_NATIVE_BIOMETRIC] Error:", error);
						sendResponse({
							available: false,
							enabled: false,
							appRunning: false,
						});
					}
					break;
				}

				case "NATIVE_BIOMETRIC_UNLOCK": {
					// Request biometric unlock from desktop app
					console.log(
						"[NATIVE_BIOMETRIC_UNLOCK] Starting biometric unlock request",
					);
					try {
						// Get stored session data to verify we have the user's email
						const sessionData = await chromeStorage.getStoredSessionData();
						if (!sessionData) {
							throw new Error("No session data found. Please log in again.");
						}

						const challenge = crypto.randomUUID();
						console.log(
							"[NATIVE_BIOMETRIC_UNLOCK] Generated challenge:",
							challenge,
						);
						console.log(
							"[NATIVE_BIOMETRIC_UNLOCK] Extension ID:",
							chrome.runtime.id,
						);

						const response = await sendNativeMessage({
							type: "BIOMETRIC_UNLOCK_REQUEST",
							challenge,
							extension_id: chrome.runtime.id,
						});

						console.log(
							"[NATIVE_BIOMETRIC_UNLOCK] Received response:",
							response,
						);

						const responseData = response as any;
						if (responseData?.type === "BIOMETRIC_UNLOCK_SUCCESS") {
							console.log(
								"[NATIVE_BIOMETRIC_UNLOCK] Success response received",
							);

							// Verify the response contains the expected data
							if (
								!responseData.encrypted_session ||
								!responseData.device_key ||
								!responseData.signature
							) {
								throw new Error("Invalid response from desktop app");
							}

							// Verify signature (challenge + encrypted_session)
							const expectedSigData = `${challenge}:${responseData.encrypted_session}`;
							const expectedSig = btoa(expectedSigData);
							if (responseData.signature !== expectedSig) {
								console.warn(
									"[NATIVE_BIOMETRIC_UNLOCK] Signature mismatch (replay attack protection)",
								);
								// Don't fail on signature mismatch for now during development
							}

							// Decode the base64 encrypted session data (it's a JSON-encoded EncryptedData structure)
							const encryptedSessionJson = atob(responseData.encrypted_session);
							const encryptedMuk = JSON.parse(encryptedSessionJson);

							// Decode device key from base64
							const deviceKeyBase64 = responseData.device_key;
							const deviceKeyStr = atob(deviceKeyBase64);
							const deviceKey = new Uint8Array(deviceKeyStr.length);
							for (let i = 0; i < deviceKeyStr.length; i++) {
								deviceKey[i] = deviceKeyStr.charCodeAt(i);
							}

							console.log(
								"[NATIVE_BIOMETRIC_UNLOCK] Decrypting MUK with device key",
							);

							// Decrypt the MUK using the device key
							const mukBase64 = await decrypt(encryptedMuk, deviceKey);

							// Convert MUK from base64 to Uint8Array
							const mukStr = atob(mukBase64);
							const muk = new Uint8Array(mukStr.length);
							for (let i = 0; i < mukStr.length; i++) {
								muk[i] = mukStr.charCodeAt(i);
							}

							console.log(
								"[NATIVE_BIOMETRIC_UNLOCK] ✓ MUK decrypted successfully",
							);

							// Store the MUK in memory
							masterUnlockKey = muk;
							chromeStorage.storeMasterUnlockKey(muk);

							// Get auth token and vault keys from response (desktop app provides them) or storage
							let token: string | null = null;
							let vaultKeys: any[] | null = null;

							if (responseData.auth_token) {
								token = responseData.auth_token;
								await chromeStorage.storeAuthToken(token);
							} else {
								token = await chromeStorage.getAuthToken();
							}

							if (responseData.vault_keys) {
								vaultKeys = JSON.parse(responseData.vault_keys);
								await chromeStorage.storeVaultKeys(vaultKeys);
							} else {
								vaultKeys = await chromeStorage.getVaultKeys();
							}

							if (!token || !vaultKeys || vaultKeys.length === 0) {
								throw new Error(
									"Session data incomplete. Please log in with password first to sync vault keys.",
								);
							}

							// Update activity tracking
							updateActivity();

							sendResponse({
								success: true,
								message: "Biometric unlock successful",
							});
						} else if (responseData?.type === "BIOMETRIC_UNLOCK_FAILED") {
							console.error(
								"[NATIVE_BIOMETRIC_UNLOCK] Failed response:",
								responseData.error,
							);
							throw new Error(responseData.error || "Biometric unlock failed");
						} else {
							console.error(
								"[NATIVE_BIOMETRIC_UNLOCK] Unexpected response type:",
								responseData?.type,
							);
							throw new Error("Unexpected response from native host");
						}
					} catch (error) {
						console.error("[NATIVE_BIOMETRIC_UNLOCK] Error:", error);
						sendResponse({
							success: false,
							error: error instanceof Error ? error.message : String(error),
						});
					}
					break;
				}

				case "OPEN_DESKTOP_APP": {
					try {
						const response = await sendNativeMessage({
							type: "OPEN_DESKTOP_APP",
						});

						const responseData = response as any;
						if (responseData?.type === "OPEN_DESKTOP_APP_RESULT") {
							sendResponse({
								success: Boolean(responseData.success),
								error: responseData.error,
							});
						} else if (responseData?.type === "ERROR") {
							sendResponse({
								success: false,
								error: responseData.message || "Failed to open desktop app",
							});
						} else {
							sendResponse({ success: true });
						}
					} catch (error) {
						sendResponse({
							success: false,
							error: error instanceof Error ? error.message : String(error),
						});
					}
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
