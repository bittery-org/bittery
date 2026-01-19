/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */

import { Button, Card, Input, Label } from "@bittery/ui";
import { Copy, ExternalLink, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Favicon } from "../favicon";
import { InlineTotpDisplay } from "./inline-totp-display";
import {
	type CategoryDetailProps,
	handleCopy,
	type LoginDisplayData,
} from "./shared";

export function LoginDetail({
	data,
	onEdit,
	onDelete,
}: CategoryDetailProps<LoginDisplayData>) {
	const [showPassword, setShowPassword] = useState(false);
	const [visibleCustomFields, setVisibleCustomFields] = useState<Set<string>>(
		new Set(),
	);

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

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-4">
				<Favicon url={data.url} title={data.title} category="login" size="lg" />
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-2xl tracking-tight">
						{data.title}
					</h2>
					{data.url && (
						<p className="mt-1 truncate text-muted-foreground text-sm">
							{data.url}
						</p>
					)}
				</div>
			</div>

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

			<div className="space-y-4">
				{data.url && (
					<div className="space-y-2">
						<Label>Website</Label>
						<div className="flex gap-2">
							<Input value={data.url} readOnly className="flex-1" />
							<Button
								size="icon"
								variant="outline"
								onClick={() => handleCopy(data.url!, "URL")}
							>
								<Copy size={16} />
							</Button>
							<Button
								size="icon"
								variant="outline"
								onClick={() => window.open(data.url, "_blank")}
							>
								<ExternalLink size={16} />
							</Button>
						</div>
					</div>
				)}

				{data.username && (
					<div className="space-y-2">
						<Label>Username</Label>
						<div className="flex gap-2">
							<Input value={data.username} readOnly className="flex-1" />
							<Button
								size="icon"
								variant="outline"
								onClick={() => handleCopy(data.username!, "Username")}
							>
								<Copy size={16} />
							</Button>
						</div>
					</div>
				)}

				{data.password && (
					<div className="space-y-2">
						<Label>Password</Label>
						<div className="flex gap-2">
							<Input
								type={showPassword ? "text" : "password"}
								value={data.password}
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
								onClick={() => handleCopy(data.password!, "Password")}
							>
								<Copy size={16} />
							</Button>
						</div>
					</div>
				)}

				{data.totpSecret && (
					<div className="space-y-2">
						<Label>One-Time Password</Label>
						<InlineTotpDisplay
							totpSecret={data.totpSecret}
							totpAlgorithm={data.totpAlgorithm}
							totpDigits={data.totpDigits}
							totpPeriod={data.totpPeriod}
						/>
					</div>
				)}

				{data.notes && (
					<div className="space-y-2">
						<Label className="font-medium text-sm">Notes</Label>
						<Card>
							<div className="whitespace-pre-wrap px-4 py-1 text-sm">
								{data.notes}
							</div>
						</Card>
					</div>
				)}

				{data.urls && data.urls.length > 0 && (
					<div className="space-y-2">
						<Label>Additional Websites</Label>
						{data.urls.map((url) => (
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

				{data.customFields && data.customFields.length > 0 && (
					<div className="space-y-3">
						{data.customFields.map((field) => (
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
