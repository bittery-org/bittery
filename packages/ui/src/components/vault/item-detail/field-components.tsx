import { useI18n } from "@bittery/i18n/react";
import { useState } from "react";
import { IconCopyOutlineDuo18, IconEyeOutlineDuo18, IconEyeSlashOutlineDuo18, IconOpenExternalOutlineDuo18 } from "../../../icons";
import { cn } from "../../../lib/utils";
import { ButtonGroup } from "../../button-group";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "../../input-group";
import { Label } from "../../label";
import type { CustomField } from "./shared";
import { handleCopy } from "./shared";

interface DetailFieldValueProps {
	value: string;
	className?: string;
}

function DetailFieldValue({ value, className }: DetailFieldValueProps) {
	return (
		<div className="min-w-0 flex-1 px-3">
			<p className={cn("truncate py-2 text-sm leading-5", className)} title={value}>
				{value}
			</p>
		</div>
	);
}

interface DetailFieldProps {
	label: string;
	value: string | undefined;
	onCopy?: boolean;
	className?: string;
	copyLabel?: string;
}

export function DetailField({
	label,
	value,
	onCopy = true,
	className,
	copyLabel,
}: DetailFieldProps) {
	const { m } = useI18n();

	if (!value) return null;

	return (
		<div className={cn("min-w-0 space-y-2", className)}>
			{label && <Label className="font-medium text-sm">{label}</Label>}
			<InputGroup className="min-w-0 overflow-hidden">
				<DetailFieldValue value={value} />
				{onCopy && (
					<InputGroupAddon align="inline-end" className="shrink-0">
						<InputGroupButton
							size="icon-sm"
							onClick={() => handleCopy(value, copyLabel ?? label, m)}
						>
							<IconCopyOutlineDuo18 className="size-4" />
						</InputGroupButton>
					</InputGroupAddon>
				)}
			</InputGroup>
		</div>
	);
}

interface DetailPasswordFieldProps {
	label: string;
	value: string | undefined;
	className?: string;
	maskValue?: string;
	copyLabel?: string;
}

export function DetailPasswordField({
	label,
	value,
	className,
	maskValue,
	copyLabel,
}: DetailPasswordFieldProps) {
	const { m } = useI18n();
	const [showPassword, setShowPassword] = useState(false);

	if (!value) return null;

	const displayValue = showPassword ? value : maskValue || value;

	return (
		<div className={cn("min-w-0 space-y-2", className)}>
			{label && <Label className="font-medium text-sm">{label}</Label>}
			<InputGroup className="min-w-0 overflow-hidden">
				<InputGroupInput
					type={showPassword ? "text" : "password"}
					value={displayValue}
					readOnly
					className="min-w-0 font-mono"
				/>
				<InputGroupAddon align="inline-end" className="shrink-0">
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
							onClick={() => handleCopy(value, copyLabel ?? label, m)}
						>
							<IconCopyOutlineDuo18 className="size-4" />
						</InputGroupButton>
					</ButtonGroup>
				</InputGroupAddon>
			</InputGroup>
		</div>
	);
}

interface DetailUrlFieldProps {
	label: string;
	value: string | undefined;
	className?: string;
	copyLabel?: string;
	onOpenUrl?: (url: string) => void;
}

function defaultOpenUrl(url: string) {
	if (typeof window === "undefined") {
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
}

export function DetailUrlField({
	label,
	value,
	className,
	copyLabel,
	onOpenUrl,
}: DetailUrlFieldProps) {
	const { m } = useI18n();

	if (!value) return null;

	const openHandler = onOpenUrl ?? defaultOpenUrl;

	return (
		<div className={cn("min-w-0 space-y-2", className)}>
			{label && <Label className="font-medium text-sm">{label}</Label>}
			<InputGroup className="min-w-0 overflow-hidden">
				<DetailFieldValue value={value} />
				<InputGroupAddon align="inline-end" className="shrink-0">
					<ButtonGroup>
						<InputGroupButton
							size="icon-sm"
							onClick={() => handleCopy(value, copyLabel ?? label, m)}
						>
							<IconCopyOutlineDuo18 className="size-4" />
						</InputGroupButton>
						<InputGroupButton size="icon-sm" onClick={() => openHandler(value)}>
							<IconOpenExternalOutlineDuo18 className="size-4" />
						</InputGroupButton>
					</ButtonGroup>
				</InputGroupAddon>
			</InputGroup>
		</div>
	);
}

interface DetailCustomFieldProps {
	field: CustomField;
	onOpenUrl?: (url: string) => void;
}

export function DetailCustomField({ field, onOpenUrl }: DetailCustomFieldProps) {
	switch (field.type) {
		case "password":
			return <DetailPasswordField label={field.label} value={field.value} />;
		case "url":
			return (
				<DetailUrlField
					label={field.label}
					value={field.value}
					onOpenUrl={onOpenUrl}
				/>
			);
		default:
			return <DetailField label={field.label} value={field.value} />;
	}
}

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

interface DetailHeaderProps {
	icon?: React.ReactNode;
	title: string;
	subtitle?: string;
}

export function DetailHeader({ icon, title, subtitle }: DetailHeaderProps) {
	return (
		<div className="flex items-center gap-4">
			{icon}
			<div className="min-w-0 flex-1">
				<h2 className="truncate font-semibold text-2xl tracking-tight">{title}</h2>
				{subtitle && (
					<p className="mt-1 truncate text-muted-foreground text-sm">{subtitle}</p>
				)}
			</div>
		</div>
	);
}
