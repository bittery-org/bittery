import { PressableFeedback } from "heroui-native";
import { Children, Fragment, isValidElement } from "react";
import { Text, View } from "react-native";
import { cn } from "@/lib/utils";
import { GlowBar } from "./brand";
import { IconChevronRight } from "./icons";
import { iconSize, layout } from "./theme";

/**
 * The grouped card that carries almost every list on mobile: one `bg-surface`
 * container, hairline dividers between rows, no borders on the rows themselves.
 */
export function ListCard({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	const rows = Children.toArray(children).filter(isValidElement);

	return (
		<View
			className={cn(
				"overflow-hidden rounded-2xl border border-border bg-surface shadow-surface",
				className,
			)}
		>
			{rows.map((row, index) => (
				<Fragment key={row.key}>
					{index > 0 ? <View className="ml-4 h-px bg-border" /> : null}
					{row}
				</Fragment>
			))}
		</View>
	);
}

export interface ListRowProps {
	title: string;
	subtitle?: string | null;
	/** Right-aligned secondary text, e.g. a count or a current value. */
	value?: string | null;
	leading?: React.ReactNode;
	trailing?: React.ReactNode;
	onPress?: () => void;
	isSelected?: boolean;
	isDisabled?: boolean;
	/** Renders the chevron affordance for rows that push a screen. */
	showChevron?: boolean;
	tone?: "default" | "danger";
	compact?: boolean;
	className?: string;
}

export function ListRow({
	title,
	subtitle,
	value,
	leading,
	trailing,
	onPress,
	isSelected = false,
	isDisabled = false,
	showChevron = false,
	tone = "default",
	compact = false,
	className,
}: ListRowProps) {
	const body = (
		<>
			{isSelected ? <GlowBar /> : null}
			{leading ? <View className="mr-3">{leading}</View> : null}
			<View className="min-w-0 flex-1">
				<Text
					numberOfLines={1}
					className={cn(
						"font-medium text-base",
						tone === "danger" ? "text-danger" : "text-foreground",
					)}
				>
					{title}
				</Text>
				{subtitle ? (
					<Text numberOfLines={1} className="mt-0.5 text-muted text-sm">
						{subtitle}
					</Text>
				) : null}
			</View>
			{value ? (
				<Text numberOfLines={1} className="ml-3 text-muted text-sm">
					{value}
				</Text>
			) : null}
			{trailing ? <View className="ml-2">{trailing}</View> : null}
			{showChevron ? (
				<IconChevronRight
					size={iconSize.row}
					className="ml-1 text-muted opacity-60"
				/>
			) : null}
		</>
	);

	const rowClassName = cn(
		"flex-row items-center px-4",
		isSelected ? "bg-selected" : "",
		isDisabled ? "opacity-50" : "",
		className,
	);
	const rowStyle = {
		minHeight: compact ? layout.rowHeightCompact : layout.rowHeight,
	};

	if (!onPress) {
		return (
			<View className={rowClassName} style={rowStyle}>
				{body}
			</View>
		);
	}

	return (
		<PressableFeedback
			onPress={onPress}
			isDisabled={isDisabled}
			className={rowClassName}
			style={rowStyle}
		>
			<PressableFeedback.Highlight />
			{body}
		</PressableFeedback>
	);
}

/** Uppercase group label that sits above a `ListCard`. */
export function SectionLabel({
	children,
	className,
	trailing,
}: {
	children: React.ReactNode;
	className?: string;
	trailing?: React.ReactNode;
}) {
	return (
		<View
			className={cn(
				"flex-row items-center justify-between px-1 pb-2",
				className,
			)}
		>
			<Text className="font-semibold text-2xs text-muted uppercase tracking-[0.06em]">
				{children}
			</Text>
			{trailing}
		</View>
	);
}
