import "./index.css";
import { Button } from "@bittery/ui";
import { CheckCircle2, Key, Lock, XCircle, Loader2 } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { Favicon } from "@/components/favicon";

interface VaultOption {
	id: string;
	name: string;
	type: "personal" | "team";
	role: "owner" | "admin" | "member" | "read-only";
}

interface ExistingCredential {
	id: string;
	vaultId: string;
	username: string;
	url: string;
}

type PromptState = "selecting" | "saving" | "success" | "error";

interface SavePromptData {
	username: string;
	password: string;
	url: string;
	vaults: VaultOption[];
	hasDuplicates?: boolean;
	existingCredentials?: ExistingCredential[];
}

// Helper to safely extract hostname from URL
function getHostname(url: string): string {
	try {
		const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
		return urlObj.hostname;
	} catch {
		return url;
	}
}

function SavePromptIframe() {
	const [data, setData] = useState<SavePromptData | null>(null);
	const [selectedVaultId, setSelectedVaultId] = useState<string>("");
	const [state, setState] = useState<PromptState>("selecting");
	const [errorMessage, setErrorMessage] = useState<string>("");
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const [isUpdating, setIsUpdating] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	// Handle resizing
	const updateHeight = React.useCallback(() => {
		if (containerRef.current) {
			// We use document.documentElement.scrollHeight to capture everything including absolute positioning if it expands the document
			// But wrapper ref scrollHeight is safer for the main content.
			// Let's use document.body.scrollHeight to be safe for the iframe
			const height = document.body.scrollHeight;
			window.parent.postMessage({ type: "RESIZE_IFRAME", height }, "*");
		}
	}, []);

	useLayoutEffect(() => {
		updateHeight();
		
		const observer = new ResizeObserver(() => {
			updateHeight();
		});

		if (document.body) {
			observer.observe(document.body);
		}
		if (containerRef.current) {
			observer.observe(containerRef.current);
		}

		return () => observer.disconnect();
	}, [updateHeight, data, state, isDropdownOpen]);

	useEffect(() => {
		// Listen for save prompt data from parent
		const handleMessage = (event: MessageEvent) => {
			if (event.data.type === "SAVE_PROMPT_DATA") {
				const promptData = event.data.data as SavePromptData;
				setData(promptData);
				// Pre-select first writable vault
				const writableVault = promptData.vaults.find(
					(v) => v.role === "owner" || v.role === "admin",
				);
				if (writableVault) {
					setSelectedVaultId(writableVault.id);
				}
				setState("selecting");
			} else if (event.data.type === "SAVE_RESULT") {
				if (event.data.success) {
					setState("success");
					// Auto-close after 2 seconds
					setTimeout(() => {
						handleCancel();
					}, 2000);
				} else {
					setState("error");
					setErrorMessage(
						event.data.error || "Failed to save credentials. Please try again.",
					);
				}
			}
		};

		window.addEventListener("message", handleMessage);

		// Notify parent that iframe is ready
		window.parent.postMessage({ type: "SAVE_IFRAME_READY" }, "*");

		return () => window.removeEventListener("message", handleMessage);
	}, []);

	const handleSave = () => {
		if (!data || !selectedVaultId) return;

		setState("saving");
		setErrorMessage("");

		if (isUpdating && data.existingCredentials && data.existingCredentials.length > 0) {
			// Update existing credential
			const existingCred = data.existingCredentials[0]; // Use the first match
			if (existingCred) {
				window.parent.postMessage(
					{
						type: "UPDATE_EXISTING_CREDENTIAL",
						itemId: existingCred.id,
						vaultId: selectedVaultId,
						username: data.username,
						password: data.password,
						url: data.url,
					},
					"*",
				);
			}
		} else {
			// Save new credential
			window.parent.postMessage(
				{
					type: "SAVE_CREDENTIAL",
					vaultId: selectedVaultId,
					username: data.username,
					password: data.password,
					url: data.url,
				},
				"*",
			);
		}
	};

	const handleCancel = () => {
		// Send cancel message to parent
		window.parent.postMessage(
			{
				type: "CANCEL_SAVE",
			},
			"*",
		);
	};

	const handleRetry = () => {
		setState("selecting");
		setErrorMessage("");
	};

	if (!data) {
		return <div ref={containerRef} className="min-h-[50px] p-1" />;
	}

	const selectedVault = data.vaults.find((v) => v.id === selectedVaultId);
	const writableVaults = data.vaults.filter(
		(v) => v.role === "owner" || v.role === "admin",
	);
	const hasWritableVaults = writableVaults.length > 0;

	// Use a common wrapper for all states
	const Wrapper = ({ children }: { children: React.ReactNode }) => (
		<div ref={containerRef} className="w-full bg-background p-4 text-foreground">
			{children}
		</div>
	);

	// Saving state
	if (state === "saving") {
		return (
			<Wrapper>
				<div className="flex items-center gap-2.5">
					<Loader2 size={20} className="shrink-0 animate-spin text-primary" />
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm">
							{isUpdating ? "Updating credentials..." : "Saving credentials..."}
						</p>
						<p className="mt-0.5 text-muted-foreground text-xs">
							{selectedVault?.name}
						</p>
					</div>
				</div>
			</Wrapper>
		);
	}

	// Success state
	if (state === "success") {
		return (
			<Wrapper>
				<div className="flex items-center gap-2.5">
					<CheckCircle2 size={20} className="shrink-0 text-green-600" />
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm">
							{isUpdating ? "Credentials updated!" : "Credentials saved!"}
						</p>
						<p className="mt-0.5 text-muted-foreground text-xs">
							{isUpdating ? `Updated in ${selectedVault?.name}` : `Saved to ${selectedVault?.name}`}
						</p>
					</div>
				</div>
			</Wrapper>
		);
	}

	// Error state
	if (state === "error") {
		return (
			<Wrapper>
				<div className="flex items-start gap-2.5">
					<XCircle size={20} className="shrink-0 text-destructive" />
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm">
							{isUpdating ? "Failed to update" : "Failed to save"}
						</p>
						<p className="mt-0.5 text-muted-foreground text-xs">
							{errorMessage}
						</p>
						{/* Show which credential failed */}
						{data && (
							<p className="mt-1 text-muted-foreground text-xs">
								<span className="font-medium">{data.username}</span> •{" "}
								{getHostname(data.url)}
							</p>
						)}
					</div>
				</div>
				<div className="mt-3 flex gap-2">
					<Button
						onClick={handleRetry}
						variant="outline"
						size="sm"
						className="flex-1"
					>
						Try Again
					</Button>
					<Button
						onClick={handleCancel}
						variant="ghost"
						size="sm"
						className="flex-1"
					>
						Cancel
					</Button>
				</div>
			</Wrapper>
		);
	}

	// No writable vaults
	if (!hasWritableVaults) {
		return (
			<Wrapper>
				<div className="flex items-start gap-2.5">
					<Lock size={20} className="shrink-0 text-amber-600" />
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm">Cannot save credentials</p>
						<p className="mt-0.5 text-muted-foreground text-xs">
							You don't have write access to any vaults.
						</p>
						{data && (
							<p className="mt-1 text-muted-foreground text-xs">
								<span className="font-medium">{data.username}</span> •{" "}
								{getHostname(data.url)}
							</p>
						)}
						<p className="mt-2 text-muted-foreground text-xs">
							💡 Ask your vault owner for write permissions, or create a new personal vault.
						</p>
					</div>
				</div>
				<div className="mt-3">
					<Button
						onClick={handleCancel}
						variant="outline"
						size="sm"
						className="w-full"
					>
						Close
					</Button>
				</div>
			</Wrapper>
		);
	}

	// Main save prompt UI
	return (
		<Wrapper>
			<div className="flex items-start gap-2.5">
				<Favicon url={data.url} title={data.url} category="login" size="sm" />
				<div className="min-w-0 flex-1">
					<p className="font-medium text-sm">
						{data.hasDuplicates ? "Update or save password?" : "Save password?"}
					</p>
					<p className="mt-0.5 truncate text-muted-foreground text-xs">
						{data.username}
					</p>
					{data.hasDuplicates && (
						<p className="mt-1 text-amber-600 text-xs">
							Credentials for this site already exist
						</p>
					)}
				</div>
			</div>

			<div className="mt-3">
				<span className="mb-1.5 block text-muted-foreground text-xs">
					Save to vault
				</span>
				<div className="relative">
					<button
						type="button"
						onClick={() => setIsDropdownOpen(!isDropdownOpen)}
						className="flex w-full items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
					>
						<div className="flex min-w-0 items-center gap-2">
							<Key size={14} className="shrink-0 text-muted-foreground" />
							<span className="truncate">
								{selectedVault?.name || "Select vault"}
							</span>
							{selectedVault && (
								<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
									{selectedVault.type}
								</span>
							)}
						</div>
						<svg
							className="shrink-0 text-muted-foreground"
							width="12"
							height="12"
							viewBox="0 0 12 12"
							fill="none"
							xmlns="http://www.w3.org/2000/svg"
							aria-hidden="true"
						>
							<title>Dropdown arrow</title>
							<path
								d="M3 4.5L6 7.5L9 4.5"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>

					{isDropdownOpen && (
						<div className="absolute top-full z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
						<div className="max-h-[150px] overflow-y-auto p-1">
								{writableVaults.map((vault) => (
									<button
										key={vault.id}
										type="button"
										onClick={() => {
											setSelectedVaultId(vault.id);
											setIsDropdownOpen(false);
										}}
										className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
											selectedVaultId === vault.id
												? "bg-accent text-accent-foreground"
												: ""
										}`}
									>
										<Key size={14} className="shrink-0 text-muted-foreground" />
										<span className="truncate">{vault.name}</span>
										<span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
											{vault.type}
										</span>
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			</div>

			{data.hasDuplicates ? (
				// Show update/save new options when duplicates exist
				<>
					<div className="mt-3 flex gap-2">
						<Button
							onClick={() => {
								setIsUpdating(true);
								handleSave();
							}}
							disabled={!selectedVaultId}
							size="sm"
							className="flex-1"
						>
							Update existing
						</Button>
						<Button
							onClick={() => {
								setIsUpdating(false);
								handleSave();
							}}
							disabled={!selectedVaultId}
							variant="outline"
							size="sm"
							className="flex-1"
						>
							Save new
						</Button>
					</div>
					<div className="mt-2">
						<Button
							onClick={handleCancel}
							variant="ghost"
							size="sm"
							className="w-full"
						>
							Cancel
						</Button>
					</div>
				</>
			) : (
				// Show normal save/cancel options when no duplicates
				<div className="mt-3 flex gap-2">
					<Button
						onClick={handleSave}
						disabled={!selectedVaultId}
						size="sm"
						className="flex-1"
					>
						Save
					</Button>
					<Button
						onClick={handleCancel}
						variant="ghost"
						size="sm"
						className="flex-1"
					>
						Cancel
					</Button>
				</div>
			)}
		</Wrapper>
	);
}

// Close dropdown when clicking outside
if (typeof window !== "undefined") {
	window.addEventListener("click", (e) => {
		const target = e.target as HTMLElement;
		if (!target.closest("[data-dropdown]")) {
			window.postMessage({ type: "CLOSE_DROPDOWN" }, "*");
		}
	});
}

const root = document.getElementById("root");
if (root) {
	ReactDOM.createRoot(root).render(
		<React.StrictMode>
			<SavePromptIframe />
		</React.StrictMode>,
	);
}