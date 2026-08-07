import { PressableFeedback } from "heroui-native";
import { useState } from "react";
import { Text, View } from "react-native";
import {
	type AppIcon,
	IconCheck,
	IconCopy,
	IconEye,
	IconEyeOff,
	iconSize,
	ListCard,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";
import type { FieldDefinition } from "./types";
import { maskValue } from "./utils";

/** How long the copy action stays acknowledged before falling back. */
const COPY_FEEDBACK_MS = 1600;

interface RowActionProps {
	icon: AppIcon;
	accessibilityLabel: string;
	onPress: () => void;
	tone?: "default" | "success";
}

/** 40pt tap target for the reveal/copy affordances on a field row. */
export function RowAction({
	icon: Icon,
	accessibilityLabel,
	onPress,
	tone = "default",
}: RowActionProps) {
	return (
		<PressableFeedback
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel}
			className="h-10 w-10 items-center justify-center rounded-full"
		>
			<PressableFeedback.Highlight />
			<Icon
				size={iconSize.row}
				className={tone === "success" ? "text-success" : "text-muted"}
			/>
		</PressableFeedback>
	);
}

interface FieldRowProps {
	field: FieldDefinition;
	onCopy: (value: string, label: string) => Promise<void>;
	isRevealed: boolean;
	onToggleReveal: () => void;
	/** Values that are their own control (a live code) opt out of the copy action. */
	isCopyable?: boolean;
}

export function FieldRow({
	field,
	onCopy,
	isRevealed,
	onToggleReveal,
	isCopyable = true,
}: FieldRowProps) {
	const { m } = useI18n();
	const [hasCopied, setHasCopied] = useState(false);
	const value = field.value ?? "";
	const Icon = field.icon;
	const isHidden = Boolean(field.masked) && !isRevealed;
	const displayValue = isHidden
		? maskValue(value)
		: (field.formattedValue ?? value);

	const handleCopy = async () => {
		await onCopy(value, field.label);
		setHasCopied(true);
		setTimeout(() => setHasCopied(false), COPY_FEEDBACK_MS);
	};

	return (
		<View className="px-4 py-3">
			<View className="flex-row items-center gap-1.5">
				{Icon ? (
					<Icon size={iconSize.chip} className="text-muted opacity-70" />
				) : null}
				<Text className="font-semibold text-2xs text-muted uppercase tracking-[0.06em]">
					{field.label}
				</Text>
				{field.badge ? (
					<Text className="rounded-lg bg-default px-1.5 py-0.5 font-medium text-2xs text-muted">
						{field.badge}
					</Text>
				) : null}
			</View>
			<View className="mt-1 flex-row items-center gap-1">
				<Text
					selectable
					numberOfLines={field.multiline && !isHidden ? undefined : 1}
					className={cn(
						"min-w-0 flex-1 text-base text-foreground",
						field.mono ? "font-mono" : "",
					)}
				>
					{displayValue}
				</Text>
				{field.masked ? (
					<RowAction
						icon={isRevealed ? IconEyeOff : IconEye}
						accessibilityLabel={
							isRevealed
								? m.mob_a11y_hide_value({ label: field.label })
								: m.mob_a11y_reveal_value({ label: field.label })
						}
						onPress={onToggleReveal}
					/>
				) : null}
				{isCopyable ? (
					<RowAction
						icon={hasCopied ? IconCheck : IconCopy}
						tone={hasCopied ? "success" : "default"}
						accessibilityLabel={
							hasCopied
								? m.mob_a11y_copied()
								: m.mob_a11y_copy_value({ label: field.label })
						}
						onPress={handleCopy}
					/>
				) : null}
			</View>
		</View>
	);
}

interface FieldGroupProps {
	fields: ReadonlyArray<FieldDefinition>;
	onCopy: (value: string, label: string) => Promise<void>;
	className?: string;
	/** Extra rows appended inside the same card, e.g. a live TOTP block. */
	children?: React.ReactNode;
}

/**
 * The grouped card every set of item values renders into. Empty fields are
 * dropped before the card is built so the hairline dividers never separate
 * nothing from nothing.
 */
export function FieldGroup({
	fields,
	onCopy,
	className,
	children,
}: FieldGroupProps) {
	const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});
	const visibleFields = fields.filter((field) => Boolean(field.value));

	if (visibleFields.length === 0 && !children) return null;

	return (
		<ListCard className={className}>
			{visibleFields.map((field) => (
				<FieldRow
					key={field.key}
					field={field}
					onCopy={onCopy}
					isRevealed={Boolean(revealedKeys[field.key])}
					onToggleReveal={() =>
						setRevealedKeys((current) => ({
							...current,
							[field.key]: !current[field.key],
						}))
					}
				/>
			))}
			{children}
		</ListCard>
	);
}
