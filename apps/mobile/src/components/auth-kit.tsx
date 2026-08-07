/**
 * The pieces the three identity surfaces (full sign-in, quick unlock and the
 * autofill unlock modal) share. Local to those screens on purpose — if a fourth
 * surface needs them they should move into `src/components/ui/`.
 */

import { Input, Label, PressableFeedback, TextField } from "heroui-native";
import { useState } from "react";
import { Image, Text, View } from "react-native";
import {
	type AppIcon,
	GradientTile,
	IconEye,
	IconEyeOff,
	IconFingerprint,
	IconScanFace,
	iconSize,
	layout,
} from "@/components/ui";
import type { BiometricTypeToken } from "@/lib/biometric-type";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";
import type { AccountMetadata } from "@/services/storage";

/** The wordmark lockup that opens the full sign-in screen. */
export function BrandLockup({ subtitle }: { subtitle?: string }) {
	return (
		<View className="items-center">
			<Image
				accessible={false}
				source={require("../../assets/logo.png")}
				style={{ width: 196, height: 66 }}
				resizeMode="contain"
			/>
			{subtitle ? (
				<Text className="mt-3 max-w-xs text-center text-muted text-sm">
					{subtitle}
				</Text>
			) : null}
		</View>
	);
}

/** The accent tile + title block the unlock surfaces open with. */
export function UnlockLockup({
	icon: Icon,
	title,
	subtitle,
	compact = false,
}: {
	icon: AppIcon;
	title: string;
	subtitle?: string | null;
	compact?: boolean;
}) {
	const size = compact ? 60 : 76;

	return (
		<View className="items-center">
			<GradientTile name="Bittery" accent glow size={size} radius={20}>
				<Icon size={compact ? 26 : 32} className="text-accent-foreground" />
			</GradientTile>
			<Text className="mt-5 text-center font-semibold text-2xl text-foreground tracking-tight">
				{title}
			</Text>
			{subtitle ? (
				<Text className="mt-1.5 text-center text-muted text-sm">
					{subtitle}
				</Text>
			) : null}
		</View>
	);
}

/** Face-vs-finger is the one thing a translated label cannot carry. */
export function BiometricGlyph({
	token,
	size = iconSize.bar,
	className,
}: {
	token: BiometricTypeToken;
	size?: number;
	className?: string;
}) {
	const Icon = token === "face" ? IconScanFace : IconFingerprint;
	return <Icon size={size} className={className} />;
}

interface AuthFieldProps {
	label: string;
	description?: string;
	icon?: AppIcon;
	value: string;
	onChangeText: (value: string) => void;
	placeholder?: string;
	isInvalid?: boolean;
	autoFocus?: boolean;
	autoCapitalize?: "none" | "characters" | "sentences" | "words";
	keyboardType?: "default" | "email-address" | "url";
	textContentType?: "emailAddress" | "password" | "none";
	inputClassName?: string;
}

/** Labelled field with an optional leading glyph well. */
export function AuthField({
	label,
	description,
	icon: Icon,
	value,
	onChangeText,
	placeholder,
	isInvalid = false,
	autoFocus,
	autoCapitalize = "none",
	keyboardType = "default",
	textContentType = "none",
	inputClassName,
}: AuthFieldProps) {
	return (
		<TextField isInvalid={isInvalid}>
			<Label>{label}</Label>
			<View className="w-full flex-row items-center">
				<Input
					placeholder={placeholder}
					value={value}
					onChangeText={onChangeText}
					autoCapitalize={autoCapitalize}
					autoCorrect={false}
					autoFocus={autoFocus}
					keyboardType={keyboardType}
					textContentType={textContentType}
					className={cn("flex-1", Icon ? "pl-11" : "", inputClassName)}
				/>
				{Icon ? (
					<Icon
						size={iconSize.bar}
						className="absolute left-3.5 text-muted"
						pointerEvents="none"
					/>
				) : null}
			</View>
			{description ? (
				<Text className="mt-1.5 px-1 text-muted text-xs">{description}</Text>
			) : null}
		</TextField>
	);
}

interface PasswordFieldProps {
	label: string;
	value: string;
	onChangeText: (value: string) => void;
	placeholder?: string;
	icon: AppIcon;
	isInvalid?: boolean;
	autoFocus?: boolean;
	onSubmit?: () => void;
}

/** Master-password entry with the reveal toggle every unlock surface carries. */
export function PasswordField({
	label,
	value,
	onChangeText,
	placeholder,
	icon: Icon,
	isInvalid = false,
	autoFocus = false,
	onSubmit,
}: PasswordFieldProps) {
	const { m } = useI18n();
	const [isRevealed, setIsRevealed] = useState(false);

	return (
		<TextField isInvalid={isInvalid}>
			<Label>{label}</Label>
			<View className="w-full flex-row items-center">
				<Input
					placeholder={placeholder}
					value={value}
					onChangeText={onChangeText}
					secureTextEntry={!isRevealed}
					textContentType="password"
					autoCapitalize="none"
					autoCorrect={false}
					autoFocus={autoFocus}
					returnKeyType="go"
					onSubmitEditing={onSubmit}
					className="flex-1 pr-12 pl-11"
				/>
				<Icon
					size={iconSize.bar}
					className="absolute left-3.5 text-muted"
					pointerEvents="none"
				/>
				<PressableFeedback
					onPress={() => setIsRevealed((revealed) => !revealed)}
					accessibilityRole="button"
					accessibilityLabel={
						isRevealed
							? m.vaults_detail_items_form_login_action_hide_password()
							: m.vaults_detail_items_form_login_action_show_password()
					}
					className="absolute right-2 h-9 w-9 items-center justify-center rounded-full"
				>
					<PressableFeedback.Highlight />
					{isRevealed ? (
						<IconEyeOff size={iconSize.bar} className="text-muted" />
					) : (
						<IconEye size={iconSize.bar} className="text-muted" />
					)}
				</PressableFeedback>
			</View>
		</TextField>
	);
}

const NOTICE_TONES = {
	danger: {
		container: "border-danger/20 bg-danger-soft",
		accent: "text-danger",
	},
	warning: {
		container: "border-warning/25 bg-warning-soft",
		accent: "text-warning",
	},
	info: {
		container: "border-info/25 bg-info/10",
		accent: "text-info",
	},
} as const;

/** Status block: coloured glyph and title over a soft tint, never a solid fill. */
export function InlineNotice({
	tone,
	icon: Icon,
	title,
	description,
	className,
}: {
	tone: keyof typeof NOTICE_TONES;
	icon: AppIcon;
	title?: string;
	description: string;
	className?: string;
}) {
	const styles = NOTICE_TONES[tone];

	return (
		<View
			className={cn(
				"flex-row items-start gap-3 rounded-xl border px-3.5 py-3",
				styles.container,
				className,
			)}
		>
			<Icon size={iconSize.row} className={cn("mt-0.5", styles.accent)} />
			<View className="min-w-0 flex-1">
				{title ? (
					<Text className={cn("font-medium text-sm", styles.accent)}>
						{title}
					</Text>
				) : null}
				<Text
					className={cn("text-sm", title ? "mt-0.5 text-muted" : styles.accent)}
				>
					{description}
				</Text>
			</View>
		</View>
	);
}

/** The "or" rule between the biometric affordance and the password form. */
export function AuthDivider({ label }: { label: string }) {
	return (
		<View className="flex-row items-center gap-3">
			<View className="h-px flex-1 bg-border" />
			<Text className="text-muted text-xs uppercase tracking-[0.06em]">
				{label}
			</Text>
			<View className="h-px flex-1 bg-border" />
		</View>
	);
}

/**
 * Account initials: teamName → name → email, first letters of up to two words.
 * Mirrors `getAccountInitials` in `packages/ui/src/components/account-switcher.tsx`;
 * a raw email is never sliced because that produces "j." artifacts.
 */
export function getAccountInitials(account?: AccountMetadata | null): string {
	if (!account) {
		return "?";
	}

	const source =
		account.teamName || account.name || account.email.split("@")[0];
	const words = (source ?? "")
		.split(/[\s._-]+/)
		.filter(Boolean)
		.slice(0, 2);

	if (words.length === 0) {
		return "?";
	}

	return words
		.map((word) => word.charAt(0))
		.join("")
		.toUpperCase();
}

/**
 * Account avatar: the accent gradient with initials, or the team's own image
 * when it has one. Accounts never take a name-hashed gradient.
 */
export function AccountAvatar({
	account,
	size = layout.iconTile,
	radius = 14,
}: {
	account?: AccountMetadata | null;
	size?: number;
	radius?: number;
}) {
	return (
		<GradientTile name="Bittery" accent size={size} radius={radius}>
			{account?.teamAvatarUrl ? (
				<Image
					source={{ uri: account.teamAvatarUrl }}
					style={{
						position: "absolute",
						width: size,
						height: size,
						borderRadius: radius,
					}}
				/>
			) : (
				<Text
					className={cn(
						"font-semibold text-accent-foreground",
						size >= 48 ? "text-base" : "text-sm",
					)}
				>
					{getAccountInitials(account)}
				</Text>
			)}
		</GradientTile>
	);
}

/** The label an account shows in lists and pickers. */
export function getAccountLabel(
	account: AccountMetadata,
	fallback: string,
): string {
	return account.teamName || account.name || account.email || fallback;
}
