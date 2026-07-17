import { useI18n } from "@bittery/i18n/react";
import { useState } from "react";
import {
	IconCopy,
	IconEye,
	IconEyeOff,
	IconOpenExternal,
} from "../../../icons";
import { cn } from "../../../lib/utils";
import type { CustomField } from "./shared";
import { handleCopy } from "./shared";

const ROW_LABEL_CLASSNAME =
	"truncate text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground";

const GROUP_LABEL_CLASSNAME =
	"mb-1.5 px-0.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground";

interface DetailFieldActionButtonProps extends React.ComponentProps<"button"> {}

export function DetailFieldActionButton({
	className,
	type = "button",
	...props
}: DetailFieldActionButtonProps) {
	return (
		<button
			type={type}
			className={cn(
				"inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

interface DetailFieldGroupProps {
	children: React.ReactNode;
	className?: string;
}

export function DetailFieldGroup({ children, className }: DetailFieldGroupProps) {
	return (
		<div
			className={cn(
				"overflow-hidden rounded-lg border bg-card [&>*+*]:border-t",
				className,
			)}
		>
			{children}
		</div>
	);
}

interface DetailGroupLabelProps {
	children: React.ReactNode;
	className?: string;
}

export function DetailGroupLabel({ children, className }: DetailGroupLabelProps) {
	return <p className={cn(GROUP_LABEL_CLASSNAME, className)}>{children}</p>;
}

interface DetailRowProps {
	children: React.ReactNode;
	onClick?: () => void;
	align?: "center" | "start";
	actions?: React.ReactNode;
	className?: string;
}

export function DetailRow({
	children,
	onClick,
	align = "center",
	actions,
	className,
}: DetailRowProps) {
	return (
		<div
			className={cn(
				"group/frow flex min-h-[46px] items-center gap-2 px-3 py-2 transition-colors hover:bg-foreground/2",
				align === "start" && "items-start py-2.5",
				className,
			)}
		>
			{onClick ? (
				<button
					type="button"
					onClick={onClick}
					className="min-w-0 flex-1 cursor-pointer rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
				>
					{children}
				</button>
			) : (
				<div className="min-w-0 flex-1">{children}</div>
			)}
			{actions && (
				<div
					className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/frow:opacity-100"
					onClick={(event) => event.stopPropagation()}
					onKeyDown={(event) => event.stopPropagation()}
				>
					{actions}
				</div>
			)}
		</div>
	);
}

interface DetailRowBodyProps {
	label?: string;
	value: React.ReactNode;
	title?: string;
	valueClassName?: string;
}

function DetailRowBody({ label, value, title, valueClassName }: DetailRowBodyProps) {
	return (
		<div className="min-w-0" title={title}>
			{label && <p className={ROW_LABEL_CLASSNAME}>{label}</p>}
			<div className={cn("truncate text-sm text-foreground", valueClassName)}>{value}</div>
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

	const copyText = copyLabel ?? label;

	return (
		<DetailRow
			className={className}
			onClick={onCopy ? () => handleCopy(value, copyText, m) : undefined}
			actions={
				onCopy ? (
					<DetailFieldActionButton onClick={() => handleCopy(value, copyText, m)}>
						<IconCopy className="size-4" />
					</DetailFieldActionButton>
				) : undefined
			}
		>
			<DetailRowBody label={label} value={value} title={value} />
		</DetailRow>
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

	const copyText = copyLabel ?? label;
	const dotMask = "•".repeat(Math.min(Math.max(value.length, 8), 24));
	const concealedValue = maskValue || dotMask;

	return (
		<DetailRow
			className={className}
			onClick={() => handleCopy(value, copyText, m)}
			actions={
				<>
					<DetailFieldActionButton
						onClick={() => setShowPassword((current) => !current)}
					>
						{showPassword ? (
							<IconEyeOff className="size-4" />
						) : (
							<IconEye className="size-4" />
						)}
					</DetailFieldActionButton>
					<DetailFieldActionButton onClick={() => handleCopy(value, copyText, m)}>
						<IconCopy className="size-4" />
					</DetailFieldActionButton>
				</>
			}
		>
			<DetailRowBody
				label={label}
				value={showPassword ? value : concealedValue}
				valueClassName={cn(
					"font-mono",
					showPassword
						? "tracking-[0.04em] text-foreground"
						: "tracking-[0.22em] text-muted-foreground",
				)}
			/>
		</DetailRow>
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
	const copyText = copyLabel ?? label;

	return (
		<DetailRow
			className={className}
			onClick={() => handleCopy(value, copyText, m)}
			actions={
				<>
					<DetailFieldActionButton onClick={() => handleCopy(value, copyText, m)}>
						<IconCopy className="size-4" />
					</DetailFieldActionButton>
					<DetailFieldActionButton onClick={() => openHandler(value)}>
						<IconOpenExternal className="size-4" />
					</DetailFieldActionButton>
				</>
			}
		>
			<DetailRowBody label={label} value={value} title={value} />
		</DetailRow>
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

interface DetailNoteFieldProps {
	label: string;
	value: string | undefined;
	copyLabel?: string;
	className?: string;
}

export function DetailNoteField({ label, value, copyLabel, className }: DetailNoteFieldProps) {
	const { m } = useI18n();

	if (!value) return null;

	const copyText = copyLabel ?? label;

	return (
		<DetailFieldGroup className={className}>
			<DetailRow
				align="start"
				onClick={() => handleCopy(value, copyText, m)}
				actions={
					<DetailFieldActionButton onClick={() => handleCopy(value, copyText, m)}>
						<IconCopy className="size-4" />
					</DetailFieldActionButton>
				}
			>
				<div className="min-w-0">
					<p className={ROW_LABEL_CLASSNAME}>{label}</p>
					<p className="whitespace-pre-wrap text-sm text-muted-foreground leading-relaxed">
						{value}
					</p>
				</div>
			</DetailRow>
		</DetailFieldGroup>
	);
}

interface DetailSectionProps {
	title: string;
	children: React.ReactNode;
}

export function DetailSection({ title, children }: DetailSectionProps) {
	return (
		<div>
			<DetailGroupLabel>{title}</DetailGroupLabel>
			<DetailFieldGroup>{children}</DetailFieldGroup>
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
		<div className="relative">
			<div
				aria-hidden="true"
				className="-top-10 -left-5 pointer-events-none absolute h-[200px] w-[340px] bg-[radial-gradient(60%_60%_at_30%_40%,color-mix(in_oklab,var(--color-primary-deep)_6%,transparent),transparent_70%)] dark:bg-[radial-gradient(60%_60%_at_30%_40%,color-mix(in_oklab,var(--color-primary-deep)_9%,transparent),transparent_70%)]"
			/>
			<div className="relative flex items-center gap-4">
				{icon && (
					<span className="shrink-0 rounded-lg shadow-[0_2px_8px_oklch(0_0_0/0.3)] dark:shadow-[inset_0_0_0_1px_oklch(1_0_0/0.08),0_2px_8px_oklch(0_0_0/0.25),0_0_24px_color-mix(in_oklab,var(--color-primary-deep)_20%,transparent)]">
						{icon}
					</span>
				)}
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-lg tracking-tight">{title}</h2>
					{subtitle && (
						<p className="mt-1 truncate text-muted-foreground text-xs">{subtitle}</p>
					)}
				</div>
			</div>
		</div>
	);
}
