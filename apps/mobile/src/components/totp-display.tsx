import { generateTotp, type TotpResult } from "@bittery/crypto-nitro";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import * as Clipboard from "expo-clipboard";
import { useToast } from "heroui-native";
import { Copy } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Text, TouchableOpacity, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
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

/**
 * TOTP Display Component
 *
 * Shows a live TOTP code with:
 * - Circular countdown timer with smooth animations
 * - Copy-to-clipboard functionality with haptic feedback
 * - Color-coded urgency (green → yellow → red)
 * - Inline mode for list views
 * - Automatic code refresh at configurable intervals
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
	const [totpResult, setTotpResult] = useState<TotpResult | null>(null);
	const [copied, setCopied] = useState(false);
	const prevCodeRef = useRef<string | null>(null);
	const fadeAnim = useRef(new Animated.Value(1)).current;
	const pulseAnim = useRef(new Animated.Value(1)).current;

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

			// Animate code change
			if (prevCodeRef.current && prevCodeRef.current !== result.code) {
				// Fade out and in when code changes
				Animated.sequence([
					Animated.timing(fadeAnim, {
						toValue: 0.3,
						duration: 150,
						useNativeDriver: true,
					}),
					Animated.timing(fadeAnim, {
						toValue: 1,
						duration: 150,
						useNativeDriver: true,
					}),
				]).start();
			}

			prevCodeRef.current = result.code;
			setTotpResult(result);
		} catch (error) {
			console.error("Failed to generate TOTP code:", error);
			setTotpResult(null);
		}
	}, [totpSecret, totpAlgorithm, totpDigits, totpPeriod, fadeAnim]);

	// Pulse animation when time is running low
	useEffect(() => {
		if (totpResult && totpResult.remainingSeconds <= 5) {
			Animated.loop(
				Animated.sequence([
					Animated.timing(pulseAnim, {
						toValue: 1.05,
						duration: 300,
						useNativeDriver: true,
					}),
					Animated.timing(pulseAnim, {
						toValue: 1,
						duration: 300,
						useNativeDriver: true,
					}),
				]),
			).start();
		} else {
			pulseAnim.setValue(1);
		}
	}, [totpResult, pulseAnim]);

	useEffect(() => {
		generateCode();

		const interval = setInterval(() => {
			generateCode();
		}, 1000);

		return () => clearInterval(interval);
	}, [generateCode]);

	const handleCopy = async () => {
		if (totpResult?.code) {
			await Clipboard.setStringAsync(totpResult.code);
			setCopied(true);

			// Call optional callback
			onCopy?.();

			// Only show toast in non-inline mode
			if (!inline) {
				toast.show({
					variant: "success",
					label: m.mob_totp_display_toast_copied(),
					placement: "bottom",
				});
			}

			// Reset copied state after 2 seconds
			setTimeout(() => setCopied(false), 2000);

			// Auto-clear clipboard after 30 seconds for security
			setTimeout(async () => {
				try {
					await Clipboard.setStringAsync("");
				} catch {
					// Ignore errors when clearing
				}
			}, 30000);
		}
	};

	// Calculate progress for the circular indicator
	const progress = totpResult?.progress || 0;
	const radius = inline ? 8 : compact ? 12 : 14;
	const strokeWidth = inline ? 1.5 : compact ? 2 : 2.5;
	const circumference = 2 * Math.PI * radius;
	const strokeDashoffset = circumference - (progress / 100) * circumference;
	const svgSize = inline ? 20 : compact ? 28 : 36;
	const center = svgSize / 2;

	// Color based on remaining time
	const getProgressColor = () => {
		if (!totpResult) return "#9ca3af"; // muted gray
		if (totpResult.remainingSeconds <= 5) return "#ef4444"; // red (destructive)
		if (totpResult.remainingSeconds <= 10) return "#eab308"; // yellow
		return "#6366f1"; // primary (indigo)
	};

	// Format code with spacing (e.g., "123 456")
	const formatCode = (code: string) => {
		if (!code) {
			if (inline) return "------";
			return compact ? "------" : "--- ---";
		}
		const midpoint = Math.floor(code.length / 2);
		return `${code.slice(0, midpoint)} ${code.slice(midpoint)}`;
	};

	if (!totpSecret) {
		return null;
	}

	// Inline mode for list items - minimal display with one-tap copy
	if (inline) {
		return (
			<TouchableOpacity
				onPress={handleCopy}
				className="flex-row items-center gap-1.5"
				accessibilityLabel={`TOTP code: ${totpResult?.code || "loading"}. Tap to copy`}
				accessibilityRole="button"
			>
				{/* Mini circular countdown */}
				<View
					className="relative items-center justify-center"
					style={{ width: svgSize, height: svgSize }}
				>
					<Svg
						width={svgSize}
						height={svgSize}
						style={{ transform: [{ rotate: "-90deg" }] }}
					>
						{/* Background circle */}
						<Circle
							cx={center}
							cy={center}
							r={radius}
							fill="none"
							stroke="#e5e7eb"
							strokeWidth={strokeWidth}
						/>
						{/* Progress circle */}
						<Circle
							cx={center}
							cy={center}
							r={radius}
							fill="none"
							stroke={getProgressColor()}
							strokeWidth={strokeWidth}
							strokeLinecap="round"
							strokeDasharray={circumference}
							strokeDashoffset={strokeDashoffset}
						/>
					</Svg>
				</View>

				{/* Inline code display with animation */}
				<Animated.Text
					className="font-bold font-mono text-foreground text-sm tracking-wide"
					style={{
						opacity: fadeAnim,
						transform: [{ scale: pulseAnim }],
						color: getProgressColor(),
					}}
				>
					{formatCode(totpResult?.code || "")}
				</Animated.Text>

				{/* Copy indicator */}
				{copied && (
					<Text className="font-medium text-green-500 text-xs">✓</Text>
				)}
			</TouchableOpacity>
		);
	}

	return (
		<View
			className={cn(
				"flex-row",
				"items-center",
				"justify-between",
				"rounded-lg",
				"border",
				"border-border",
				"bg-muted/30",
				compact ? "p-2" : "p-3",
			)}
		>
			<TouchableOpacity
				onPress={handleCopy}
				className="flex-row items-center gap-3"
				accessibilityLabel={`TOTP code: ${totpResult?.code || "loading"}. Tap to copy`}
				accessibilityRole="button"
			>
				{/* Circular countdown timer with animation */}
				<Animated.View
					className="relative items-center justify-center"
					style={{
						width: svgSize,
						height: svgSize,
						transform: [{ scale: pulseAnim }],
					}}
				>
					<Svg
						width={svgSize}
						height={svgSize}
						style={{ transform: [{ rotate: "-90deg" }] }}
					>
						{/* Background circle */}
						<Circle
							cx={center}
							cy={center}
							r={radius}
							fill="none"
							stroke="#e5e7eb"
							strokeWidth={strokeWidth}
						/>
						{/* Progress circle */}
						<Circle
							cx={center}
							cy={center}
							r={radius}
							fill="none"
							stroke={getProgressColor()}
							strokeWidth={strokeWidth}
							strokeLinecap="round"
							strokeDasharray={circumference}
							strokeDashoffset={strokeDashoffset}
						/>
					</Svg>
					{/* Seconds remaining text */}
					<Text
						className={cn(
							"absolute",
							"font-medium",
							"font-mono",
							compact ? "text-xs" : "text-xs",
						)}
						style={{ color: getProgressColor() }}
					>
						{totpResult?.remainingSeconds ?? "--"}
					</Text>
				</Animated.View>

				{/* Code display with fade animation */}
				<View className="flex-col">
					<Animated.Text
						className={cn(
							"font-bold",
							"font-mono",
							"text-foreground",
							"tracking-widest",
							compact ? "text-lg" : "text-2xl",
						)}
						style={{ opacity: fadeAnim }}
					>
						{formatCode(totpResult?.code || "")}
					</Animated.Text>
					{!compact && <Text className="text-muted text-xs">{resolvedLabel}</Text>}
				</View>
			</TouchableOpacity>

			{/* Copy button */}
			<TouchableOpacity
				onPress={handleCopy}
				disabled={!totpResult?.code}
				className={cn(
					"rounded-lg",
					"border",
					"border-input",
					"bg-background",
					compact ? "p-2" : "p-2.5",
				)}
				accessibilityLabel="Copy code to clipboard"
				accessibilityRole="button"
			>
				<Copy size={compact ? 16 : 18} color={copied ? "#22c55e" : "#6b7280"} />
			</TouchableOpacity>
		</View>
	);
}
