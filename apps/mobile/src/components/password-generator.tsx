import {
	generatePassword,
	type PasswordOptions,
} from "@bittery/shared/password";
import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import Slider from "@react-native-community/slider";
import * as Clipboard from "expo-clipboard";
import { getRandomValues } from "expo-crypto";
import {
	BottomSheet,
	ControlField,
	Input,
	Label,
	PressableFeedback,
	Switch,
	TextField,
	useThemeColor,
	useToast,
} from "heroui-native";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import {
	BrandButton,
	IconCheck,
	IconCopy,
	IconRefresh,
	IconSparkles,
	iconSize,
	ListCard,
	SectionLabel,
	Segmented,
	SheetBrandAccent,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";

interface PasswordGeneratorProps {
	children: React.ReactNode;
	onPasswordGenerated: (password: string) => void;
	defaultOptions?: PasswordOptions;
}

const MIN_LENGTH = 8;
const MAX_LENGTH = 64;
const COPY_FEEDBACK_MS = 2000;
/** A generated password sitting in the clipboard is a liability past this. */
const CLIPBOARD_CLEAR_MS = 30000;

// Word lists for memorable passwords
const adjectives = [
	"happy",
	"sunny",
	"brave",
	"swift",
	"calm",
	"bright",
	"clever",
	"gentle",
	"fierce",
	"golden",
	"silver",
	"crystal",
	"cosmic",
	"lunar",
	"solar",
	"royal",
	"ancient",
	"mighty",
	"noble",
	"wild",
	"quiet",
	"bold",
	"warm",
	"cool",
];

const nouns = [
	"tiger",
	"eagle",
	"river",
	"mountain",
	"forest",
	"ocean",
	"thunder",
	"phoenix",
	"dragon",
	"falcon",
	"panther",
	"wolf",
	"bear",
	"hawk",
	"lion",
	"dolphin",
	"castle",
	"garden",
	"bridge",
	"valley",
	"meadow",
	"storm",
	"flame",
	"frost",
];

/**
 * Generate a memorable password using word combinations
 */
function generateMemorablePassword(
	wordCount = 4,
	includeNumber = true,
): string {
	const words: string[] = [];
	let randomValues = new Uint8Array(wordCount + 1);
	randomValues = getRandomValues(randomValues);

	for (let i = 0; i < wordCount; i++) {
		const val = randomValues[i];
		if (val !== undefined) {
			if (i % 2 === 0) {
				words.push(adjectives[val % adjectives.length] ?? "happy");
			} else {
				words.push(nouns[val % nouns.length] ?? "tiger");
			}
		}
	}

	// Capitalize first letter of each word
	const capitalizedWords = words.map(
		(word) => word.charAt(0).toUpperCase() + word.slice(1),
	);

	// Add a number if requested
	if (includeNumber && randomValues[wordCount] !== undefined) {
		const num = (randomValues[wordCount] % 99) + 1;
		capitalizedWords.push(num.toString());
	}

	return capitalizedWords.join("-");
}

type StrengthTone = "none" | "weak" | "fair" | "good" | "strong";

const STRENGTH_CLASSES: Record<StrengthTone, { text: string; bar: string }> = {
	none: { text: "text-muted", bar: "bg-border" },
	weak: { text: "text-danger", bar: "bg-danger" },
	fair: { text: "text-warning", bar: "bg-warning" },
	good: { text: "text-info", bar: "bg-info" },
	strong: { text: "text-success", bar: "bg-success" },
};

/** Character-class breadth plus length, scored out of 8 and read as a percentage. */
function scorePassword(password: string): number {
	let score = 0;
	if (password.length >= 8) score += 1;
	if (password.length >= 12) score += 1;
	if (password.length >= 16) score += 1;
	if (password.length >= 20) score += 1;
	if (/[a-z]/.test(password)) score += 1;
	if (/[A-Z]/.test(password)) score += 1;
	if (/[0-9]/.test(password)) score += 1;
	if (/[^a-zA-Z0-9]/.test(password)) score += 1;
	return (score / 8) * 100;
}

function IconAction({
	icon: Icon,
	accessibilityLabel,
	onPress,
	tone = "default",
}: {
	icon: typeof IconCopy;
	accessibilityLabel: string;
	onPress: () => void;
	tone?: "default" | "success";
}) {
	return (
		<PressableFeedback
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel}
			className="h-12 w-12 items-center justify-center rounded-xl border border-border bg-surface"
		>
			<PressableFeedback.Highlight />
			<Icon
				size={iconSize.bar}
				className={tone === "success" ? "text-success" : "text-foreground"}
			/>
		</PressableFeedback>
	);
}

export function PasswordGenerator({
	children,
	onPasswordGenerated,
	defaultOptions,
}: PasswordGeneratorProps) {
	const { toast } = useToast();
	const { m } = useI18n();
	const [accent, border] = useThemeColor(["accent", "border"]);
	const [isOpen, setIsOpen] = useState(false);
	const [password, setPassword] = useState("");
	const [hasCopied, setHasCopied] = useState(false);
	const [passwordType, setPasswordType] = useState<"random" | "memorable">(
		"random",
	);
	const [options, setOptions] = useState<Required<PasswordOptions>>({
		length: defaultOptions?.length ?? 20,
		lowercase: defaultOptions?.lowercase ?? true,
		uppercase: defaultOptions?.uppercase ?? true,
		numbers: defaultOptions?.numbers ?? true,
		symbols: defaultOptions?.symbols ?? true,
		generateRandomValues: getRandomValues,
	});

	// Memorable password options
	const [wordCount, setWordCount] = useState(4);
	const [includeNumber, setIncludeNumber] = useState(true);

	const handleGenerate = useCallback(() => {
		setPassword(
			passwordType === "memorable"
				? generateMemorablePassword(wordCount, includeNumber)
				: generatePassword(options),
		);
	}, [options, passwordType, wordCount, includeNumber]);

	const handleCopy = async () => {
		if (!password) return;

		await Clipboard.setStringAsync(password);
		setHasCopied(true);
		setTimeout(() => setHasCopied(false), COPY_FEEDBACK_MS);

		toast.show({
			variant: "success",
			label: m.mob_password_gen_toast_copied(),
			placement: "bottom",
		});

		setTimeout(async () => {
			try {
				await Clipboard.setStringAsync("");
			} catch {
				// Ignore errors when clearing
			}
		}, CLIPBOARD_CLEAR_MS);
	};

	const handleUse = () => {
		if (password) {
			onPasswordGenerated(password);
			setIsOpen(false);
		}
	};

	const updateOption = <K extends keyof PasswordOptions>(
		key: K,
		value: PasswordOptions[K],
	) => {
		const nextOptions = { ...options, [key]: value };
		setOptions(nextOptions);
		if (isOpen && passwordType === "random") {
			setPassword(generatePassword(nextOptions));
		}
	};

	const score = password ? scorePassword(password) : 0;
	const tone: StrengthTone = !password
		? "none"
		: score < 40
			? "weak"
			: score < 60
				? "fair"
				: score < 80
					? "good"
					: "strong";
	const strengthLabel = {
		none: m.mob_password_gen_strength_none(),
		weak: m.mob_password_gen_strength_weak(),
		fair: m.mob_password_gen_strength_fair(),
		good: m.mob_password_gen_strength_good(),
		strong: m.mob_password_gen_strength_strong(),
	}[tone];

	// At least one character class must stay on, or generation has nothing to draw from.
	const canToggleOption =
		[
			options.lowercase,
			options.uppercase,
			options.numbers,
			options.symbols,
		].filter(Boolean).length > 1;

	const characterClasses = [
		{ key: "lowercase" as const, label: m.mob_password_gen_lowercase() },
		{ key: "uppercase" as const, label: m.mob_password_gen_uppercase() },
		{ key: "numbers" as const, label: m.mob_password_gen_numbers() },
		{ key: "symbols" as const, label: m.mob_password_gen_symbols() },
	];

	return (
		<BottomSheet
			isOpen={isOpen}
			onOpenChange={(open) => {
				setIsOpen(open);
				if (open) {
					handleGenerate();
					return;
				}
				setPassword("");
				setHasCopied(false);
			}}
		>
			<BottomSheet.Trigger asChild>{children}</BottomSheet.Trigger>
			<BottomSheet.Portal>
				<BottomSheet.Overlay />
				<BottomSheet.Content snapPoints={["90%"]}>
					<SheetBrandAccent />
					<View className="mb-3 flex-row items-center justify-center gap-2">
						<IconSparkles size={iconSize.bar} className="text-accent" />
						<BottomSheet.Title className="font-semibold text-foreground text-lg">
							{m.mob_password_gen_title()}
						</BottomSheet.Title>
					</View>

					<BottomSheetScrollView
						className="flex-1"
						contentContainerClassName="gap-5 px-4 pb-6"
					>
						<Segmented
							options={[
								{
									value: "random",
									label: m.mob_password_gen_type_random(),
								},
								{
									value: "memorable",
									label: m.mob_password_gen_type_memorable(),
								},
							]}
							value={passwordType}
							onChange={(value) => {
								const nextType = value as "random" | "memorable";
								setPasswordType(nextType);
								if (!isOpen) return;
								setPassword(
									nextType === "memorable"
										? generateMemorablePassword(wordCount, includeNumber)
										: generatePassword(options),
								);
							}}
						/>

						<View>
							<SectionLabel>
								{m.mob_password_gen_generated_label()}
							</SectionLabel>
							<View className="flex-row items-center gap-2">
								<View className="min-h-12 flex-1 justify-center rounded-xl border border-border bg-field px-4 py-3">
									<Text
										className="font-mono text-base text-foreground"
										selectable
										numberOfLines={3}
									>
										{password}
									</Text>
								</View>
								<IconAction
									icon={IconRefresh}
									accessibilityLabel={m.mob_password_gen_title()}
									onPress={handleGenerate}
								/>
								<IconAction
									icon={hasCopied ? IconCheck : IconCopy}
									tone={hasCopied ? "success" : "default"}
									accessibilityLabel={
										hasCopied
											? m.mob_a11y_copied()
											: m.mob_a11y_copy_value({
													label: m.mob_form_login_password_label(),
												})
									}
									onPress={handleCopy}
								/>
							</View>

							<View className="mt-3 rounded-xl border border-border bg-surface p-3">
								<View className="flex-row items-center justify-between">
									<Text className="text-muted text-sm">
										{m.mob_password_gen_strength_label()}
									</Text>
									<Text
										className={cn(
											"font-semibold text-sm",
											STRENGTH_CLASSES[tone].text,
										)}
									>
										{strengthLabel}
									</Text>
								</View>
								<View className="mt-2 h-1.5 overflow-hidden rounded-full bg-default">
									<View
										className={cn(
											"h-full rounded-full",
											STRENGTH_CLASSES[tone].bar,
										)}
										style={{ width: `${Math.max(score, 2)}%` }}
									/>
								</View>
							</View>
						</View>

						{passwordType === "random" ? (
							<>
								<View>
									<SectionLabel>
										{m.mob_password_gen_length_label()}
									</SectionLabel>
									<View className="rounded-2xl border border-border bg-surface p-4">
										<View className="flex-row items-center justify-between">
											<Text className="font-medium text-base text-foreground">
												{m.mob_password_gen_length_label()}
											</Text>
											<TextField className="w-16">
												<Input
													className="px-2 py-1 text-center font-mono"
													value={String(options.length)}
													onChangeText={(text) => {
														const next = Number.parseInt(text, 10);
														if (
															!Number.isNaN(next) &&
															next >= MIN_LENGTH &&
															next <= MAX_LENGTH
														) {
															updateOption("length", next);
														}
													}}
													keyboardType="numeric"
													selectTextOnFocus
												/>
											</TextField>
										</View>
										<View className="mt-1 flex-row items-center gap-2">
											<Text className="font-mono text-muted text-xs">
												{MIN_LENGTH}
											</Text>
											<Slider
												style={{ flex: 1, height: 40 }}
												minimumValue={MIN_LENGTH}
												maximumValue={MAX_LENGTH}
												step={1}
												value={options.length}
												onValueChange={(value) =>
													updateOption("length", Math.round(value))
												}
												minimumTrackTintColor={accent}
												maximumTrackTintColor={border}
												thumbTintColor={accent}
											/>
											<Text className="font-mono text-muted text-xs">
												{MAX_LENGTH}
											</Text>
										</View>
									</View>
								</View>

								<View>
									<SectionLabel>
										{m.mob_password_gen_include_label()}
									</SectionLabel>
									<ListCard>
										{characterClasses.map(({ key, label }) => (
											<ControlField
												key={key}
												isSelected={options[key]}
												onSelectedChange={(value) => {
													if (canToggleOption || value) {
														updateOption(key, value);
													}
												}}
												isDisabled={!canToggleOption && options[key]}
												className="px-4 py-3"
											>
												<Label className="flex-1">{label}</Label>
												<ControlField.Indicator>
													<Switch />
												</ControlField.Indicator>
											</ControlField>
										))}
									</ListCard>
								</View>
							</>
						) : (
							<>
								<View>
									<SectionLabel>
										{m.mob_password_gen_word_count_label()}
									</SectionLabel>
									<Segmented
										options={[3, 4, 5, 6].map((count) => ({
											value: String(count),
											label: String(count),
										}))}
										value={String(wordCount)}
										onChange={(value) => {
											const nextCount = Number(value);
											setWordCount(nextCount);
											if (isOpen) {
												setPassword(
													generateMemorablePassword(nextCount, includeNumber),
												);
											}
										}}
									/>
								</View>

								<ListCard>
									<ControlField
										isSelected={includeNumber}
										onSelectedChange={(value) => {
											setIncludeNumber(value);
											if (isOpen) {
												setPassword(
													generateMemorablePassword(wordCount, value),
												);
											}
										}}
										className="px-4 py-3"
									>
										<Label className="flex-1">
											{m.mob_password_gen_include_number()}
										</Label>
										<ControlField.Indicator>
											<Switch />
										</ControlField.Indicator>
									</ControlField>
								</ListCard>

								<View className="rounded-2xl bg-accent-soft p-4">
									<Text className="text-accent-soft-foreground text-sm">
										{m.mob_password_gen_memorable_hint()}
									</Text>
								</View>
							</>
						)}
					</BottomSheetScrollView>

					<View className="border-border border-t px-4 pt-3 pb-2">
						<BrandButton
							label={m.mob_password_gen_use_button()}
							onPress={handleUse}
							isDisabled={!password}
							size="lg"
						/>
					</View>
				</BottomSheet.Content>
			</BottomSheet.Portal>
		</BottomSheet>
	);
}
