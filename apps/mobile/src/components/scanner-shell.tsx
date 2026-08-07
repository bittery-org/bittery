/**
 * Shared chrome for the two camera scanners (TOTP QR and device setup QR).
 *
 * The live camera is not a themed surface, so the capture overlay is the one
 * place white-on-black is correct; every other pixel uses the theme.
 */

import { Button, PressableFeedback } from "heroui-native";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
	AppBar,
	BrandButton,
	IconCamera,
	IconFlashlight,
	IconFlashlightOff,
	IconX,
	iconSize,
	layout,
	Screen,
} from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";

function CloseButton({
	onPress,
	label,
	onCamera = false,
}: {
	onPress: () => void;
	label: string;
	onCamera?: boolean;
}) {
	return (
		<PressableFeedback
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label}
			className={
				onCamera
					? "h-10 w-10 items-center justify-center rounded-full bg-black/40"
					: "-mr-2 h-9 w-9 items-center justify-center rounded-full"
			}
		>
			<PressableFeedback.Highlight />
			<IconX
				size={iconSize.bar}
				className={onCamera ? "text-white" : "text-muted"}
			/>
		</PressableFeedback>
	);
}

/** Shown while `useCameraPermissions` has not reported yet. */
export function ScannerLoading({
	title,
	label,
	onClose,
}: {
	title: string;
	label: string;
	onClose: () => void;
}) {
	const { m } = useI18n();

	return (
		<Screen>
			<AppBar
				title={title}
				actions={
					<CloseButton onPress={onClose} label={m.mob_qr_scanner_cancel()} />
				}
			/>
			<View className="flex-1 items-center justify-center px-8">
				<Text className="text-center text-muted text-sm">{label}</Text>
			</View>
		</Screen>
	);
}

/** The camera-permission ask. */
export function ScannerPermission({
	title,
	heading,
	description,
	allowLabel,
	cancelLabel,
	onAllow,
	onClose,
}: {
	title: string;
	heading: string;
	description: string;
	allowLabel: string;
	cancelLabel: string;
	onAllow: () => void;
	onClose: () => void;
}) {
	return (
		<Screen>
			<AppBar
				title={title}
				actions={<CloseButton onPress={onClose} label={cancelLabel} />}
			/>
			<View
				className="flex-1 items-center justify-center"
				style={{ paddingHorizontal: layout.gap.lg }}
			>
				<View className="h-16 w-16 items-center justify-center rounded-2xl border border-border bg-surface">
					<IconCamera size={28} className="text-muted" />
				</View>
				<Text className="mt-5 text-center font-semibold text-foreground text-lg">
					{heading}
				</Text>
				<Text className="mt-2 max-w-xs text-center text-muted text-sm">
					{description}
				</Text>
				<View className="mt-7 w-full gap-2.5">
					<BrandButton label={allowLabel} onPress={onAllow} size="lg" />
					<Button onPress={onClose} variant="tertiary" size="lg">
						{cancelLabel}
					</Button>
				</View>
			</View>
		</Screen>
	);
}

/** The capture overlay drawn on top of the live camera feed. */
export function ScannerOverlay({
	title,
	instruction,
	statusLabel,
	isTorchEnabled,
	onToggleTorch,
	onClose,
}: {
	title: string;
	instruction: string;
	statusLabel?: string | null;
	isTorchEnabled: boolean;
	onToggleTorch: () => void;
	onClose: () => void;
}) {
	const { m } = useI18n();
	const insets = useSafeAreaInsets();

	return (
		<View className="flex-1">
			<View
				className="flex-row items-center justify-between gap-3 bg-black/45 px-4 pb-3"
				style={{ paddingTop: insets.top + layout.gap.xs }}
			>
				<CloseButton
					onPress={onClose}
					label={m.mob_qr_scanner_cancel()}
					onCamera
				/>
				<Text
					numberOfLines={1}
					className="min-w-0 flex-1 text-center font-semibold text-base text-white"
				>
					{title}
				</Text>
				<PressableFeedback
					onPress={onToggleTorch}
					accessibilityRole="button"
					accessibilityLabel={m.mob_qr_scanner_torch()}
					className="h-10 w-10 items-center justify-center rounded-full bg-black/40"
				>
					<PressableFeedback.Highlight />
					{isTorchEnabled ? (
						<IconFlashlightOff size={iconSize.bar} className="text-white" />
					) : (
						<IconFlashlight size={iconSize.bar} className="text-white" />
					)}
				</PressableFeedback>
			</View>

			<View className="flex-1 items-center justify-center">
				<View className="h-64 w-64">
					<View className="absolute top-0 left-0 h-10 w-10 rounded-tl-2xl border-white border-t-2 border-l-2" />
					<View className="absolute top-0 right-0 h-10 w-10 rounded-tr-2xl border-white border-t-2 border-r-2" />
					<View className="absolute bottom-0 left-0 h-10 w-10 rounded-bl-2xl border-white border-b-2 border-l-2" />
					<View className="absolute right-0 bottom-0 h-10 w-10 rounded-br-2xl border-white border-r-2 border-b-2" />
				</View>
			</View>

			<View
				className="bg-black/45 px-6 pt-5"
				style={{ paddingBottom: insets.bottom + layout.gap.lg }}
			>
				<Text className="text-center text-sm text-white">{instruction}</Text>
				{statusLabel ? (
					<Text className="mt-2 text-center text-white/70 text-xs">
						{statusLabel}
					</Text>
				) : null}
			</View>
		</View>
	);
}
