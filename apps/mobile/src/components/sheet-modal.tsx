import { PressableFeedback } from "heroui-native";
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import {
	type AppIcon,
	IconX,
	iconSize,
	SheetBrandAccent,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";

interface SheetModalProps {
	visible: boolean;
	onClose: () => void;
	title: string;
	icon?: AppIcon;
	description?: string;
	/** Blocks the backdrop and the close affordance while work is in flight. */
	isBusy?: boolean;
	children: React.ReactNode;
	className?: string;
}

/**
 * The app's bottom-sheet shell: surface-secondary on a themed backdrop, with
 * the sanctioned accent header wash. Screens compose their body inside it
 * rather than rebuilding the chrome.
 */
export function SheetModal({
	visible,
	onClose,
	title,
	icon: Icon,
	description,
	isBusy = false,
	children,
	className,
}: SheetModalProps) {
	const { m } = useI18n();
	const insets = useSafeAreaInsets();
	const [backdrop] = useCSSVariable(["--backdrop"]);

	const requestClose = () => {
		if (!isBusy) onClose();
	};

	return (
		<Modal
			visible={visible}
			transparent
			animationType="slide"
			onRequestClose={requestClose}
		>
			<View
				className="flex-1 justify-end"
				style={{ backgroundColor: String(backdrop) }}
			>
				<Pressable
					className="flex-1"
					onPress={requestClose}
					accessibilityRole="button"
					accessibilityLabel={m.mob_common_close()}
				/>
				<View
					className={cn(
						"max-h-[88%] overflow-hidden rounded-t-2xl border-border border-t bg-surface-secondary shadow-overlay",
						className,
					)}
					style={{ paddingBottom: insets.bottom + 16 }}
				>
					<SheetBrandAccent />
					<View className="items-center pt-2.5">
						<View className="h-1 w-9 rounded-full bg-border" />
					</View>
					<View className="flex-row items-center gap-2 px-4 pt-3 pb-1">
						{Icon ? <Icon size={iconSize.bar} className="text-accent" /> : null}
						<Text
							numberOfLines={1}
							className="min-w-0 flex-1 font-semibold text-foreground text-lg"
						>
							{title}
						</Text>
						<PressableFeedback
							onPress={requestClose}
							isDisabled={isBusy}
							accessibilityRole="button"
							accessibilityLabel={m.mob_common_close()}
							className="-mr-1 h-9 w-9 items-center justify-center rounded-full"
						>
							<PressableFeedback.Highlight />
							<IconX size={iconSize.bar} className="text-muted" />
						</PressableFeedback>
					</View>
					{description ? (
						<Text className="px-4 pb-3 text-muted text-sm">{description}</Text>
					) : (
						<View className="h-2" />
					)}
					{children}
				</View>
			</View>
		</Modal>
	);
}
