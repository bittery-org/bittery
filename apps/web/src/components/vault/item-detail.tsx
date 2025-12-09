/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */
import { Copy, ExternalLink, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Favicon } from "@/components/vault/favicon";
import { copyToClipboard } from "@/lib/crypto";

export interface CustomField {
	id: string;
	label: string;
	value: string;
	type: "text" | "password" | "email" | "url";
}

interface LoginData {
	title: string;
	url?: string;
	urls?: string[];
	username?: string;
	password?: string;
	notes?: string;
	customFields?: CustomField[];
}

interface SecureNoteData {
	title: string;
	note: string;
}

interface ItemDetailProps {
	category: "login" | "secure-note";
	data: LoginData | SecureNoteData;
	onEdit?: () => void;
	onDelete?: () => void;
}

export default function ItemDetail({
	category,
	data,
	onEdit,
	onDelete,
}: ItemDetailProps) {
	const [showPassword, setShowPassword] = useState(false);
	const [visibleCustomFields, setVisibleCustomFields] = useState<Set<string>>(
		new Set(),
	);

	const handleCopy = async (text: string, label: string) => {
		await copyToClipboard(text, 30000);
		toast.success(`${label} copied to clipboard (auto-clear in 30s)`);
	};

	const toggleCustomFieldVisibility = (fieldId: string) => {
		setVisibleCustomFields((prev) => {
			const next = new Set(prev);
			if (next.has(fieldId)) {
				next.delete(fieldId);
			} else {
				next.add(fieldId);
			}
			return next;
		});
	};

	if (category === "login") {
		const loginData = data as LoginData;

		return (
			<div className="space-y-4">
				{/* Header with favicon */}
				<div className="flex items-center gap-4">
					<Favicon
						url={loginData.url}
						title={loginData.title}
						category="login"
						size="lg"
					/>
					<div className="min-w-0 flex-1">
						<h2 className="truncate font-semibold text-2xl tracking-tight">
							{loginData.title}
						</h2>
						{loginData.url && (
							<p className="mt-1 truncate text-muted-foreground text-sm">
								{loginData.url}
							</p>
						)}
					</div>
				</div>

				<div className="flex items-start justify-between gap-4">
					<div className="flex gap-2">
						{onEdit && (
							<Button size="sm" variant="outline" onClick={onEdit}>
								Edit
							</Button>
						)}
						{onDelete && (
							<Button
								size="sm"
								variant="ghost"
								className="text-destructive hover:bg-destructive/10 hover:text-destructive"
								onClick={onDelete}
							>
								Delete
							</Button>
						)}
					</div>
				</div>

				<div className="space-y-4">
					{loginData.url && (
						<div className="space-y-2">
							<Label>Website</Label>
							<div className="flex gap-2">
								<Input value={loginData.url} readOnly className="flex-1" />
								<Button
									size="icon"
									variant="outline"
									onClick={() => handleCopy(loginData.url!, "URL")}
								>
									<Copy size={16} />
								</Button>
								<Button
									size="icon"
									variant="outline"
									onClick={() => window.open(loginData.url, "_blank")}
								>
									<ExternalLink size={16} />
								</Button>
							</div>
						</div>
					)}

					{loginData.username && (
						<div className="space-y-2">
							<Label>Username</Label>
							<div className="flex gap-2">
								<Input value={loginData.username} readOnly className="flex-1" />
								<Button
									size="icon"
									variant="outline"
									onClick={() => handleCopy(loginData.username!, "Username")}
								>
									<Copy size={16} />
								</Button>
							</div>
						</div>
					)}

					{loginData.password && (
						<div className="space-y-2">
							<Label>Password</Label>
							<div className="flex gap-2">
								<Input
									type={showPassword ? "text" : "password"}
									value={loginData.password}
									readOnly
									className="flex-1 font-mono"
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
									onClick={() => handleCopy(loginData.password!, "Password")}
								>
									<Copy size={16} />
								</Button>
							</div>
						</div>
					)}

					{loginData.notes && (
						<div className="space-y-2">
							<Label className="font-medium text-sm">Notes</Label>
							<Card>
								<div className="whitespace-pre-wrap px-4 py-1 text-sm">
									{loginData.notes}
								</div>
							</Card>
						</div>
					)}

					{/* Additional URLs */}
					{loginData.urls && loginData.urls.length > 0 && (
						<div className="space-y-2">
							<Label>Additional Websites</Label>
							{loginData.urls.map((url) => (
								<div key={url} className="flex gap-2">
									<Input value={url} readOnly className="flex-1" />
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
										onClick={() => window.open(url, "_blank")}
									>
										<ExternalLink size={16} />
									</Button>
								</div>
							))}
						</div>
					)}

					{/* Custom Fields */}
					{loginData.customFields && loginData.customFields.length > 0 && (
						<div className="space-y-3">
							{loginData.customFields.map((field) => (
								<div key={field.id} className="space-y-2">
									<Label className="text-sm">{field.label}</Label>
									<div className="flex gap-2">
										<Input
											type={
												field.type === "password" &&
												!visibleCustomFields.has(field.id)
													? "password"
													: "text"
											}
											value={field.value}
											readOnly
											className="flex-1"
										/>
										{field.type === "password" && (
											<Button
												size="icon"
												variant="outline"
												onClick={() => toggleCustomFieldVisibility(field.id)}
											>
												{visibleCustomFields.has(field.id) ? (
													<EyeOff size={16} />
												) : (
													<Eye size={16} />
												)}
											</Button>
										)}
										<Button
											size="icon"
											variant="outline"
											onClick={() => handleCopy(field.value, field.label)}
										>
											<Copy size={16} />
										</Button>
										{field.type === "url" && (
											<Button
												size="icon"
												variant="outline"
												onClick={() => window.open(field.value, "_blank")}
											>
												<ExternalLink size={16} />
											</Button>
										)}
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		);
	}

	// Secure Note
	const noteData = data as SecureNoteData;

	return (
		<div className="space-y-4">
			{/* Header with icon for secure notes */}
			<div className="flex items-center gap-4">
				<Favicon title={noteData.title} category="secure-note" size="lg" />
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-2xl tracking-tight">
						{noteData.title}
					</h2>
					<p className="mt-1 text-muted-foreground text-sm">Secure Note</p>
				</div>
			</div>

			<div className="flex items-start justify-between gap-4">
				<div className="flex gap-2">
					{onEdit && (
						<Button size="sm" variant="outline" onClick={onEdit}>
							Edit
						</Button>
					)}
					{onDelete && (
						<Button
							size="sm"
							variant="ghost"
							className="text-destructive hover:bg-destructive/10 hover:text-destructive"
							onClick={onDelete}
						>
							Delete
						</Button>
					)}
				</div>
			</div>

			<Card>
				<div className="whitespace-pre-wrap p-6 leading-relaxed">
					{noteData.note}
				</div>
			</Card>
		</div>
	);
}
