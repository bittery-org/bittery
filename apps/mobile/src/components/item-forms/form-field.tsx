import { FieldError, Input, Label, TextField } from "heroui-native";
import type { ComponentProps } from "react";
import { Pressable, Text, View } from "react-native";
import { IconEye, IconEyeOff, iconSize } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";

interface FormFieldProps {
	label: string;
	/** Rendered in the `danger` tone under the field; also marks it invalid. */
	error?: string | null;
	isRequired?: boolean;
	className?: string;
	/** Right-aligned annotation on the label row, e.g. a detected card brand. */
	labelAccessory?: React.ReactNode;
	children: React.ReactNode;
}

/** Label + control + validation message, the one shape every form row takes. */
export function FormField({
	label,
	error,
	isRequired = false,
	className,
	labelAccessory,
	children,
}: FormFieldProps) {
	return (
		<TextField
			isRequired={isRequired}
			isInvalid={error ? true : undefined}
			className={className}
		>
			{labelAccessory ? (
				<View className="mb-1 flex-row items-center justify-between">
					<Label>{label}</Label>
					{labelAccessory}
				</View>
			) : (
				<Label>{label}</Label>
			)}
			{children}
			{error ? <FieldError>{error}</FieldError> : null}
		</TextField>
	);
}

/**
 * `FormField` for controls that are not a `TextField` — a select trigger, a
 * segmented control — where heroui's field context would have nothing to bind.
 */
export function FieldShell({
	label,
	error,
	className,
	children,
}: Omit<FormFieldProps, "isRequired" | "labelAccessory">) {
	return (
		<View className={className}>
			<Label className="mb-2">{label}</Label>
			{children}
			{error ? (
				<Text className="mt-1.5 text-danger text-sm">{error}</Text>
			) : null}
		</View>
	);
}

interface SecretInputProps extends ComponentProps<typeof Input> {
	isRevealed: boolean;
	onToggleReveal: () => void;
	/** Names the value in the reveal control's accessibility label. */
	revealLabel: string;
}

/** A masked input with the reveal toggle sitting inside its trailing edge. */
export function SecretInput({
	isRevealed,
	onToggleReveal,
	revealLabel,
	className,
	...inputProps
}: SecretInputProps) {
	const { m } = useI18n();

	return (
		<View className="w-full flex-row items-center">
			<Input
				{...inputProps}
				secureTextEntry={!isRevealed}
				className={cn("flex-1 pr-12", className)}
			/>
			<Pressable
				onPress={onToggleReveal}
				accessibilityRole="button"
				accessibilityLabel={
					isRevealed
						? m.mob_a11y_hide_value({ label: revealLabel })
						: m.mob_a11y_reveal_value({ label: revealLabel })
				}
				hitSlop={12}
				className="absolute right-3"
			>
				{isRevealed ? (
					<IconEyeOff size={iconSize.bar} className="text-muted" />
				) : (
					<IconEye size={iconSize.bar} className="text-muted" />
				)}
			</Pressable>
		</View>
	);
}
