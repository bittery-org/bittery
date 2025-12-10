import { Button, Card, Label, Skeleton } from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Copy, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function ItemDetailPage() {
	const navigate = useNavigate();
	const { itemId } = useParams({ from: "/item/$itemId" });
	const [showPassword, setShowPassword] = useState(false);

	const { data: item, isLoading } = useQuery({
		queryKey: ["vault-item", itemId],
		queryFn: async () => {
			const response = await chrome.runtime.sendMessage({
				type: "GET_VAULT_ITEM",
				payload: { itemId },
			});
			return response.item;
		},
	});

	const copyToClipboard = async (text: string, label: string) => {
		await navigator.clipboard.writeText(text);
		toast.success(`${label} copied to clipboard`);
	};

	if (isLoading) {
		return (
			<div className="space-y-4 p-4">
				<Skeleton className="h-8 w-32" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	}

	if (!item) {
		return (
			<div className="flex h-[400px] items-center justify-center p-4">
				<p className="text-muted-foreground text-sm">Item not found</p>
			</div>
		);
	}

	return (
		<div className="flex h-[400px] flex-col">
			<div className="border-b bg-background p-4">
				<div className="flex items-center gap-2">
					<Button
						size="icon"
						variant="ghost"
						onClick={() => navigate({ to: "/vault" })}
					>
						<ArrowLeft size={18} />
					</Button>
					<h1 className="font-semibold text-lg">{item.name}</h1>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto p-4">
				<Card className="space-y-4 p-4">
					{item.username && (
						<div className="space-y-2">
							<Label>Username</Label>
							<div className="flex gap-2">
								<div className="flex-1 rounded-md border bg-muted px-3 py-2 text-sm">
									{item.username}
								</div>
								<Button
									size="icon"
									variant="outline"
									onClick={() => copyToClipboard(item.username, "Username")}
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
								<div className="flex-1 rounded-md border bg-muted px-3 py-2 font-mono text-sm">
									{showPassword ? item.password : "••••••••"}
								</div>
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
									onClick={() => copyToClipboard(item.password, "Password")}
								>
									<Copy size={16} />
								</Button>
							</div>
						</div>
					)}

					{item.websiteUrl && (
						<div className="space-y-2">
							<Label>Website</Label>
							<div className="flex gap-2">
								<div className="flex-1 truncate rounded-md border bg-muted px-3 py-2 text-sm">
									{item.websiteUrl}
								</div>
								<Button
									size="icon"
									variant="outline"
									onClick={() => copyToClipboard(item.websiteUrl, "URL")}
								>
									<Copy size={16} />
								</Button>
							</div>
						</div>
					)}

					{item.notes && (
						<div className="space-y-2">
							<Label>Notes</Label>
							<div className="rounded-md border bg-muted px-3 py-2 text-sm">
								{item.notes}
							</div>
						</div>
					)}
				</Card>
			</div>
		</div>
	);
}
