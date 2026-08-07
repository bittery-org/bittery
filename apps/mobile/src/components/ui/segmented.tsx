import { PressableFeedback } from "heroui-native";
import { ScrollView, Text, View } from "react-native";
import { cn } from "@/lib/utils";
import type { AppIcon } from "./icons";
import { iconSize } from "./theme";

export interface SegmentedOption<T extends string> {
	value: T;
	label: string;
}

/**
 * Two-or-three-way switch that splits a screen's content (Vaults / Tags).
 * Sits on the `default` rung with a raised `segment` thumb.
 */
export function Segmented<T extends string>({
	options,
	value,
	onChange,
	className,
}: {
	options: ReadonlyArray<SegmentedOption<T>>;
	value: T;
	onChange: (value: T) => void;
	className?: string;
}) {
	return (
		<View
			className={cn(
				"flex-row rounded-xl border border-border bg-default p-1",
				className,
			)}
		>
			{options.map((option) => {
				const isActive = option.value === value;
				return (
					<PressableFeedback
						key={option.value}
						onPress={() => onChange(option.value)}
						className={cn(
							"flex-1 items-center justify-center rounded-lg py-2",
							isActive ? "bg-segment shadow-surface" : "",
						)}
					>
						{isActive ? null : <PressableFeedback.Highlight />}
						<Text
							className={cn(
								"font-medium text-sm",
								isActive ? "text-foreground" : "text-muted",
							)}
						>
							{option.label}
						</Text>
					</PressableFeedback>
				);
			})}
		</View>
	);
}

export interface FilterChip<T extends string> {
	value: T;
	label: string;
	icon?: AppIcon;
	count?: number;
}

/**
 * Horizontally scrolling filter rail (item categories). Selected chips take the
 * selection tint plus an accent ring — never a solid purple fill.
 */
export function ChipRail<T extends string>({
	chips,
	value,
	onChange,
	contentClassName,
}: {
	chips: ReadonlyArray<FilterChip<T>>;
	value: T;
	onChange: (value: T) => void;
	contentClassName?: string;
}) {
	return (
		<ScrollView
			horizontal
			showsHorizontalScrollIndicator={false}
			contentContainerClassName={cn("flex-row gap-2 px-4", contentClassName)}
		>
			{chips.map((chip) => {
				const isActive = chip.value === value;
				const Icon = chip.icon;
				return (
					<PressableFeedback
						key={chip.value}
						onPress={() => onChange(chip.value)}
						className={cn(
							"h-9 flex-row items-center gap-1.5 rounded-full border px-3.5",
							isActive
								? "border-accent/25 bg-selected"
								: "border-border bg-surface",
						)}
					>
						<PressableFeedback.Highlight />
						{Icon ? (
							<Icon
								size={iconSize.chip}
								className={isActive ? "text-accent" : "text-muted"}
							/>
						) : null}
						<Text
							className={cn(
								"font-medium text-sm",
								isActive ? "text-accent" : "text-foreground",
							)}
						>
							{chip.label}
						</Text>
						{typeof chip.count === "number" ? (
							<Text
								className={cn(
									"text-xs",
									isActive ? "text-accent/70" : "text-muted",
								)}
							>
								{chip.count}
							</Text>
						) : null}
					</PressableFeedback>
				);
			})}
		</ScrollView>
	);
}
