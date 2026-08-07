import { generateTotp, type TotpResult } from "@bittery/crypto-nitro";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import * as Clipboard from "expo-clipboard";
import { PressableFeedback, useThemeColor, useToast } from "heroui-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { IconCheck, IconCopy, iconSize } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";

interface TotpDisplayProps {
	totpSecret: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
	/** Whether to show in compact mode (smaller size) */
	compact?: boolean;
	/** Whether to show in inline mode for list items (minimal size, no copy button) */
	inline?: boolean;
	/** Optional label to show below the code */
	label?: string;
	/** Callback when code is copied */
	onCopy?: () => void;
}

/** Seconds left at which the ring escalates from accent to warning, then danger. */
const WARNING_THRESHOLD_SECONDS = 10;
const DANGER_THRESHOLD_SECONDS = 5;
const COPY_FEEDBACK_MS = 2000;
/** A one-time code is worthless after its window; the clipboard should be too. */
const CLIPBOARD_CLEAR_MS = 30000;

const RING = {
	inline: { size: 22, stroke: 2 },
	compact: { size: 32, stroke: 2.5 },
	default: { size: 40, stroke: 3 },
} as const;

function CountdownRing({
	progress,
	remainingSeconds,
	color,
	trackColor,
	variant,
}: {
	progress: number;
	remainingSeconds: number | null;
	color: string;
	trackColor: string;
	variant: keyof typeof RING;
}) {
	const { size, stroke } = RING[variant];
	const center = size / 2;
	const radius = center - stroke;
	const circumference = 2 * Math.PI * radius;

	return (
		<View
			className="items-center justify-center"
			style={{ width: size, height: size }}
		>
			<Svg
				width={size}
				height={size}
				style={{ transform: [{ rotate: "-90deg" }] }}
			>
				<Circle
					cx={center}
					cy={center}
					r={radius}
					fill="none"
					stroke={trackColor}
					strokeWidth={stroke}
				/>
				<Circle
					cx={center}
					cy={center}
					r={radius}
					fill="none"
					stroke={color}
					strokeWidth={stroke}
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={circumference - (progress / 100) * circumference}
				/>
			</Svg>
			{variant === "default" && remainingSeconds !== null ? (
				<Text
					className="absolute font-medium font-mono text-2xs"
					style={{ color }}
				>
					{remainingSeconds}
				</Text>
			) : null}
		</View>
	);
}

/**
 * A live one-time code with its countdown ring. The 1s interval is the one
 * sanctioned `useEffect` in this app — the code is a function of wall-clock
 * time, so nothing but a timer can derive it.
 */
export function TotpDisplay({
	totpSecret,
	totpAlgorithm = "SHA1",
	totpDigits = 6,
	totpPeriod = 30,
	compact = false,
	inline = false,
	label,
	onCopy,
}: TotpDisplayProps) {
	const { m } = useI18n();
	const resolvedLabel = label ?? m.mob_totp_display_label();
	const { toast } = useToast();
	const [accent, warning, danger, muted, border] = useThemeColor([
		"accent",
		"warning",
		"danger",
		"muted",
		"border",
	]);
	const [totpResult, setTotpResult] = useState<TotpResult | null>(null);
	const [hasCopied, setHasCopied] = useState(false);
	const previousCodeRef = useRef<string | null>(null);
	const fadeAnim = useRef(new Animated.Value(1)).current;

	const generateCode = useCallback(() => {
		if (!totpSecret) {
			setTotpResult(null);
			return;
		}

		try {
			const result = generateTotp({
				secret: totpSecret,
				algorithm: totpAlgorithm,
				digits: totpDigits,
				period: totpPeriod,
			});

			if (previousCodeRef.current && previousCodeRef.current !== result.code) {
				Animated.sequence([
					Animated.timing(fadeAnim, {
						toValue: 0.3,
						duration: 120,
						useNativeDriver: true,
					}),
					Animated.timing(fadeAnim, {
						toValue: 1,
						duration: 160,
						useNativeDriver: true,
					}),
				]).start();
			}

			previousCodeRef.current = result.code;
			setTotpResult(result);
		} catch (error) {
			console.error("Failed to generate TOTP code:", error);
			setTotpResult(null);
		}
	}, [totpSecret, totpAlgorithm, totpDigits, totpPeriod, fadeAnim]);

	useEffect(() => {
		generateCode();
		const interval = setInterval(generateCode, 1000);
		return () => clearInterval(interval);
	}, [generateCode]);

	const handleCopy = async () => {
		if (!totpResult?.code) return;

		await Clipboard.setStringAsync(totpResult.code);
		setHasCopied(true);
		onCopy?.();

		if (!inline) {
			toast.show({
				variant: "success",
				label: m.mob_totp_display_toast_copied(),
				placement: "bottom",
			});
		}

		setTimeout(() => setHasCopied(false), COPY_FEEDBACK_MS);
		setTimeout(async () => {
			try {
				await Clipboard.setStringAsync("");
			} catch {
				// Ignore errors when clearing
			}
		}, CLIPBOARD_CLEAR_MS);
	};

	const remainingSeconds = totpResult?.remainingSeconds ?? null;
	const ringColor =
		remainingSeconds === null
			? muted
			: remainingSeconds <= DANGER_THRESHOLD_SECONDS
				? danger
				: remainingSeconds <= WARNING_THRESHOLD_SECONDS
					? warning
					: accent;

	const formatCode = (code: string | undefined) => {
		if (!code) return inline || compact ? "------" : "--- ---";
		const midpoint = Math.floor(code.length / 2);
		return `${code.slice(0, midpoint)} ${code.slice(midpoint)}`;
	};

	if (!totpSecret) {
		return null;
	}

	if (inline) {
		return (
			<Pressable
				onPress={handleCopy}
				className="flex-row items-center gap-2"
				accessibilityLabel={m.mob_totp_a11y_copy_code()}
				accessibilityRole="button"
			>
				<CountdownRing
					variant="inline"
					progress={totpResult?.progress ?? 0}
					remainingSeconds={remainingSeconds}
					color={ringColor}
					trackColor={border}
				/>
				<Animated.Text
					className="font-medium font-mono text-foreground text-sm tracking-wide"
					style={{ opacity: fadeAnim }}
				>
					{formatCode(totpResult?.code)}
				</Animated.Text>
			</Pressable>
		);
	}

	return (
		<View className="flex-row items-center gap-3">
			<CountdownRing
				variant={compact ? "compact" : "default"}
				progress={totpResult?.progress ?? 0}
				remainingSeconds={remainingSeconds}
				color={ringColor}
				trackColor={border}
			/>
			<View className="min-w-0 flex-1">
				<Animated.Text
					className={cn(
						"font-mono text-foreground tracking-widest",
						compact ? "text-lg" : "text-2xl",
					)}
					style={{ opacity: fadeAnim }}
					selectable
				>
					{formatCode(totpResult?.code)}
				</Animated.Text>
				{compact ? null : (
					<Text numberOfLines={1} className="mt-0.5 text-muted text-xs">
						{resolvedLabel}
					</Text>
				)}
			</View>
			<PressableFeedback
				onPress={handleCopy}
				isDisabled={!totpResult?.code}
				accessibilityRole="button"
				accessibilityLabel={
					hasCopied ? m.mob_a11y_copied() : m.mob_totp_a11y_copy_code()
				}
				className="h-10 w-10 items-center justify-center rounded-full"
			>
				<PressableFeedback.Highlight />
				{hasCopied ? (
					<IconCheck size={iconSize.row} className="text-success" />
				) : (
					<IconCopy size={iconSize.row} className="text-muted" />
				)}
			</PressableFeedback>
		</View>
	);
}
