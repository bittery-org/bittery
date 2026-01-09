import { Button, Card, Input, Label, toast } from "@bittery/ui";
import { Copy, ExternalLink, Eye, EyeOff, Star } from "lucide-react";
import { useState } from "react";
import { Favicon } from "./favicon";

export interface VaultItemOverview {
	title?: string;
	url?: string;
	username?: string;
}

export interface VaultItem {
	id: string;
	category?: "login" | "secure-note" | string;
	favorite?: boolean;
	title?: string;
	name?: string;
	url?: string;
	websiteUrl?: string;
	username?: string;
	password?: string;
	notes?: string;
	note?: string;
	urls?: string[];
	overview?: VaultItemOverview;
}

export const getItemTitle = (item: VaultItem) =>
	item.title || item.name || item.overview?.title || "Untitled";

export const getItemUrl = (item: VaultItem) =>
	item.url || item.websiteUrl || item.overview?.url || "";

export const getItemUsername = (item: VaultItem) =>
	item.username || item.overview?.username || "";

export const getItemNotes = (item: VaultItem) => item.notes || item.note || "";

export const getItemCategory = (item: VaultItem) =>
	item.category === "secure-note" || Boolean(item.note) ? "secure-note" : "login";

const normalizeUrl = (url: string) =>
	url.includes("://") ? url : `https://${url}`;

interface ItemDetailPanelProps {
	item: VaultItem;
}

export function ItemDetailPanel({
	item,
}: ItemDetailPanelProps) {
	const [showPassword, setShowPassword] = useState(false);
	const category = getItemCategory(item);
	const title = getItemTitle(item);
	const url = getItemUrl(item);
	const username = getItemUsername(item);
	const notes = getItemNotes(item);
	const isSecureNote = category === "secure-note";

	const handleCopy = async (text: string, label: string) => {
		try {
			await navigator.clipboard.writeText(text);
			toast.success(`${label} copied to clipboard`);
		} catch {
			toast.error("Failed to copy to clipboard");
		}
	};

	const handleOpenUrl = (targetUrl: string) => {
		window.open(normalizeUrl(targetUrl), "_blank", "noopener,noreferrer");
	};

	return (
		<div className="space-y-5">
			<div className="flex items-start gap-4">
				<Favicon
					url={isSecureNote ? undefined : url}
					title={title}
					category={category}
					size="lg"
				/>
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-xl tracking-tight">
						{title}
					</h2>
					{url ? (
						<p className="mt-1 truncate text-muted-foreground text-sm">{url}</p>
					) : isSecureNote ? (
						<p className="mt-1 text-muted-foreground text-sm">Secure Note</p>
					) : null}
				</div>
			</div>

			{isSecureNote ? (
				<div className="space-y-2">
					<Label>Note</Label>
					<Card className="p-4 text-sm leading-relaxed whitespace-pre-wrap">
						{notes || "No notes added yet."}
					</Card>
				</div>
			) : (
				<div className="space-y-4">
					{url && (
						<div className="space-y-2">
							<Label>Website</Label>
							<div className="flex gap-2">
								<Input value={url} readOnly className="h-9 flex-1" />
								<Button
									size="icon"
									variant="outline"
									onClick={() => handleCopy(url, "URL")}
								>
									<Copy size={16} />
								</Button>
								<Button
									size="icon"
									variant="outline"
									onClick={() => handleOpenUrl(url)}
								>
									<ExternalLink size={16} />
								</Button>
							</div>
						</div>
					)}

					{username && (
						<div className="space-y-2">
							<Label>Username</Label>
							<div className="flex gap-2">
								<Input value={username} readOnly className="h-9 flex-1" />
								<Button
									size="icon"
									variant="outline"
									onClick={() => handleCopy(username, "Username")}
								>
									<Copy size={16} />
								</Button>
							</div>
						</div>
					)}

					{item.password && (
						<div className="space-y-2">
							<Label>Password</Label>
							<div className="flex gap-2">
								<Input
									type={showPassword ? "text" : "password"}
									value={item.password}
									readOnly
									className="h-9 flex-1 font-mono"
								/>
								<Button
									size="icon"
									variant="outline"
									onClick={() => setShowPassword(!showPassword)}
								>
									{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
								</Button>
								<Button
									size="icon"
									variant="outline"
									onClick={() => handleCopy(item.password!, "Password")}
								>
									<Copy size={16} />
								</Button>
							</div>
						</div>
					)}

					{notes && (
						<div className="space-y-2">
							<Label>Notes</Label>
							<Card className="p-4 text-sm leading-relaxed whitespace-pre-wrap">
								{notes}
							</Card>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
