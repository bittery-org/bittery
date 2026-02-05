import {
	ButtonGroup,
	cn,
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	Label,
} from "@bittery/ui";
import {
	IconCopyOutlineDuo18,
	IconOpenExternalOutlineDuo18,
	IconEyeOutlineDuo18,
	IconEyeSlashOutlineDuo18,
} from "@bittery/ui/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import type { CustomField } from "./shared";
import { handleCopy } from "./shared";

// Basic read-only field with optional copy button
interface DetailFieldProps {
	label: string;
	value: string | undefined;
	onCopy?: boolean;
	className?: string;
}

export function DetailField({
	label,
	value,
	onCopy = true,
	className,
}: DetailFieldProps) {
	if (!value) return null;

	return (
		<div className={cn("space-y-2", className)}>
			<Label className="font-medium text-sm">{label}</Label>
			<InputGroup>
				<InputGroupInput value={value} readOnly />
				{onCopy && (
					<InputGroupAddon align="inline-end">
						<InputGroupButton
							size="icon-sm"
							onClick={() => handleCopy(value, label)}
						>
							<IconCopyOutlineDuo18 className="size-4" />
						</InputGroupButton>
					</InputGroupAddon>
				)}
			</InputGroup>
		</div>
	);
}

// Password field with reveal + copy
interface DetailPasswordFieldProps {
	label: string;
	value: string | undefined;
	className?: string;
	maskValue?: string;
}

export function DetailPasswordField({
	label,
	value,
	className,
	maskValue,
}: DetailPasswordFieldProps) {
	const [showPassword, setShowPassword] = useState(false);

	if (!value) return null;

	const displayValue = showPassword ? value : maskValue || value;

	return (
		<div className={cn("space-y-2", className)}>
			<Label className="font-medium text-sm">{label}</Label>
			<InputGroup>
				<InputGroupInput
					type={showPassword ? "text" : "password"}
					value={displayValue}
					readOnly
					className="font-mono"
				/>
				<InputGroupAddon align="inline-end">
					<ButtonGroup>
						<InputGroupButton
							size="icon-sm"
							onClick={() => setShowPassword(!showPassword)}
						>
							{showPassword ? (
								<IconEyeSlashOutlineDuo18 className="size-4" />
							) : (
								<IconEyeOutlineDuo18 className="size-4" />
							)}
						</InputGroupButton>
						<InputGroupButton
							size="icon-sm"
							onClick={() => handleCopy(value, label)}
						>
							<IconCopyOutlineDuo18 className="size-4" />
						</InputGroupButton>
					</ButtonGroup>
				</InputGroupAddon>
			</InputGroup>
		</div>
	);
}

// URL field with copy + open
interface DetailUrlFieldProps {
	label: string;
	value: string | undefined;
	className?: string;
}

export function DetailUrlField({
	label,
	value,
	className,
}: DetailUrlFieldProps) {
	if (!value) return null;

	return (
		<div className={cn("space-y-2", className)}>
			<Label className="font-medium text-sm">{label}</Label>
			<InputGroup>
				<InputGroupInput value={value} readOnly />
				<InputGroupAddon align="inline-end">
					<ButtonGroup>
						<InputGroupButton
							size="icon-sm"
							onClick={() => handleCopy(value, label)}
						>
							<IconCopyOutlineDuo18 className="size-4" />
						</InputGroupButton>
						<InputGroupButton size="icon-sm" onClick={() => openUrl(value)}>
							<IconOpenExternalOutlineDuo18 className="size-4" />
						</InputGroupButton>
					</ButtonGroup>
				</InputGroupAddon>
			</InputGroup>
		</div>
	);
}

// Dynamic field router for custom fields
interface DetailCustomFieldProps {
	field: CustomField;
}

export function DetailCustomField({ field }: DetailCustomFieldProps) {
	switch (field.type) {
		case "password":
			return <DetailPasswordField label={field.label} value={field.value} />;
		case "url":
			return <DetailUrlField label={field.label} value={field.value} />;
		default:
			return <DetailField label={field.label} value={field.value} />;
	}
}

// Grouped fields with section header
interface DetailSectionProps {
	title: string;
	children: React.ReactNode;
}

export function DetailSection({ title, children }: DetailSectionProps) {
	return (
		<div className="space-y-3 rounded-lg border p-4">
			<h3 className="font-semibold text-sm">{title}</h3>
			<div className="space-y-3">{children}</div>
		</div>
	);
}

// Consistent item header
interface DetailHeaderProps {
	icon: React.ReactNode;
	title: string;
	subtitle?: string;
}

export function DetailHeader({ icon, title, subtitle }: DetailHeaderProps) {
	return (
		<div className="flex items-center gap-4">
			{icon}
			<div className="min-w-0 flex-1">
				<h2 className="truncate font-semibold text-2xl tracking-tight">
					{title}
				</h2>
				{subtitle && (
					<p className="mt-1 truncate text-muted-foreground text-sm">
						{subtitle}
					</p>
				)}
			</div>
		</div>
	);
}
