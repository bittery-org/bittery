import { Text, View } from "react-native";
import { cn } from "@/lib/utils";
import { BrandButton } from "./brand-button";
import type { AppIcon } from "./icons";
import { iconSize } from "./theme";

interface EmptyStateProps {
	icon: AppIcon;
	title: string;
	description?: string;
	actionLabel?: string;
	onAction?: () => void;
	className?: string;
}

/** The one empty/zero-data treatment: neutral icon well, title, one action. */
export function EmptyState({
	icon: Icon,
	title,
	description,
	actionLabel,
	onAction,
	className,
}: EmptyStateProps) {
	return (
		<View
			className={cn("flex-1 items-center justify-center px-8 py-12", className)}
		>
			<View className="h-16 w-16 items-center justify-center rounded-2xl border border-border bg-surface">
				<Icon size={28} className="text-muted" />
			</View>
			<Text className="mt-5 text-center font-semibold text-foreground text-lg">
				{title}
			</Text>
			{description ? (
				<Text className="mt-2 max-w-xs text-center text-muted text-sm">
					{description}
				</Text>
			) : null}
			{actionLabel && onAction ? (
				<BrandButton
					label={actionLabel}
					onPress={onAction}
					fullWidth={false}
					className="mt-6"
				/>
			) : null}
		</View>
	);
}

/** Inline error block used when a query fails inside a screen body. */
export function ErrorState({
	icon: Icon,
	title,
	description,
	actionLabel,
	onAction,
}: EmptyStateProps) {
	return (
		<View className="flex-1 items-center justify-center px-8 py-12">
			<View className="h-16 w-16 items-center justify-center rounded-2xl bg-danger-soft">
				<Icon size={iconSize.header} className="text-danger" />
			</View>
			<Text className="mt-5 text-center font-semibold text-foreground text-lg">
				{title}
			</Text>
			{description ? (
				<Text className="mt-2 max-w-xs text-center text-muted text-sm">
					{description}
				</Text>
			) : null}
			{actionLabel && onAction ? (
				<BrandButton
					label={actionLabel}
					onPress={onAction}
					fullWidth={false}
					className="mt-6"
				/>
			) : null}
		</View>
	);
}
