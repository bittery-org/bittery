import type { DecryptedItem } from "@bittery/shared/types";
import { Button, Card, Input, Label, toast } from "@bittery/ui";
import { Copy, ExternalLink, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Favicon } from "./favicon";

const getItemNotes = (item: DecryptedItem) => item.notes || item.note || "";

const normalizeUrl = (url: string) =>
	url.includes("://") ? url : `https://${url}`;

const handleCopy = async (text: string | null | undefined, label: string) => {
	if (!text) {
		toast.error(`No ${label.toLowerCase()} to copy`);
		return;
	}

	try {
		await navigator.clipboard.writeText(text);
		toast.success(`${label} copied to clipboard`);
	} catch {
		toast.error("Failed to copy to clipboard");
	}
};

const handleOpenUrl = (targetUrl: string | undefined) => {
	if (!targetUrl) {
		toast.error("No URL to open");
		return;
	}

	window.open(normalizeUrl(targetUrl), "_blank", "noopener,noreferrer");
};

interface ItemDetailPanelProps {
	item: DecryptedItem;
}

function LoginItemDetail({ item }: { item: DecryptedItem }) {
	const [showPassword, setShowPassword] = useState(false);
	const notes = getItemNotes(item);

	return (
		<div className="space-y-4">
			{item.url && (
				<div className="space-y-2">
					<Label>Website</Label>
					<div className="flex gap-2">
						<Input value={item.url} readOnly className="h-9 flex-1" />
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(item.url, "URL")}
						>
							<Copy size={16} />
						</Button>
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleOpenUrl(item.url)}
						>
							<ExternalLink size={16} />
						</Button>
					</div>
				</div>
			)}

			{item.username && (
				<div className="space-y-2">
					<Label>Username</Label>
					<div className="flex gap-2">
						<Input value={item.username} readOnly className="h-9 flex-1" />
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(item.username, "Username")}
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
							onClick={() => handleCopy(item.password, "Password")}
						>
							<Copy size={16} />
						</Button>
					</div>
				</div>
			)}

			{notes && (
				<div className="space-y-2">
					<Label>Notes</Label>
					<Card className="whitespace-pre-wrap p-4 text-sm leading-relaxed">
						{notes}
					</Card>
				</div>
			)}
		</div>
	);
}

function SecureNoteDetail({ item }: { item: DecryptedItem }) {
	const notes = getItemNotes(item);

	return (
		<div className="space-y-2">
			<Label>Note</Label>
			<Card className="whitespace-pre-wrap p-4 text-sm leading-relaxed">
				{notes || "No notes added yet."}
			</Card>
		</div>
	);
}

function CreditCardDetail({ item }: { item: DecryptedItem }) {
	const notes = getItemNotes(item);

	return (
		<div className="space-y-4">
			<div className="text-muted-foreground text-sm">
				Credit card details coming soon
			</div>
			{notes && (
				<div className="space-y-2">
					<Label>Notes</Label>
					<Card className="whitespace-pre-wrap p-4 text-sm leading-relaxed">
						{notes}
					</Card>
				</div>
			)}
		</div>
	);
}

function IdentityDetail({ item }: { item: DecryptedItem }) {
	const notes = getItemNotes(item);

	return (
		<div className="space-y-4">
			<div className="text-muted-foreground text-sm">
				Identity details coming soon
			</div>
			{notes && (
				<div className="space-y-2">
					<Label>Notes</Label>
					<Card className="whitespace-pre-wrap p-4 text-sm leading-relaxed">
						{notes}
					</Card>
				</div>
			)}
		</div>
	);
}

export function ItemDetailPanel({ item }: ItemDetailPanelProps) {
	const isSecureNote = item.category === "secure-note";

	return (
		<div className="space-y-5">
			<div className="flex items-start gap-4">
				<Favicon
					url={isSecureNote ? undefined : item.url}
					title={item.title}
					category={item.category}
					size="lg"
				/>
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-xl tracking-tight">
						{item.title}
					</h2>
					{item.url ? (
						<p className="mt-1 truncate text-muted-foreground text-sm">
							{item.url}
						</p>
					) : isSecureNote ? (
						<p className="mt-1 text-muted-foreground text-sm">Secure Note</p>
					) : null}
				</div>
			</div>

			{item.category === "secure-note" && <SecureNoteDetail item={item} />}
			{item.category === "login" && <LoginItemDetail item={item} />}
			{item.category === "credit-card" && <CreditCardDetail item={item} />}
			{item.category === "identity" && <IdentityDetail item={item} />}
		</div>
	);
}
