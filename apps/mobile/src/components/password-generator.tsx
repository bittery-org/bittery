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
	Button,
	ControlField,
	Input,
	Label,
	Switch,
	TextField,
	useToast,
} from "heroui-native";
import { Check, Copy, RefreshCw, Sparkles } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { withUniwind } from "uniwind";

// Create styled icon components
const StyledCheck = withUniwind(Check);
const StyledCopy = withUniwind(Copy);
const StyledRefreshCw = withUniwind(RefreshCw);
const StyledSparkles = withUniwind(Sparkles);

interface PasswordGeneratorProps {
	children: React.ReactNode;
	onPasswordGenerated: (password: string) => void;
	defaultOptions?: PasswordOptions;
}

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

export function PasswordGenerator({
	children,
	onPasswordGenerated,
	defaultOptions,
}: PasswordGeneratorProps) {
	const { toast } = useToast();
	const [isOpen, setIsOpen] = useState(false);
	const [password, setPassword] = useState("");
	const [copied, setCopied] = useState(false);
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
		if (passwordType === "memorable") {
			const newPassword = generateMemorablePassword(wordCount, includeNumber);
			setPassword(newPassword);
		} else {
			const newPassword = generatePassword(options);
			setPassword(newPassword);
		}
	}, [options, passwordType, wordCount, includeNumber]);

	const handleCopy = async () => {
		if (password) {
			await Clipboard.setStringAsync(password);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);

			toast.show({
				variant: "success",
				label: "Password copied to clipboard",
				placement: "bottom",
			});

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

	// Calculate password strength
	const getPasswordStrength = () => {
		if (!password) return { score: 0, label: "None", color: "#d1d5db" };

		let score = 0;
		const length = password.length;

		// Length scoring
		if (length >= 8) score += 1;
		if (length >= 12) score += 1;
		if (length >= 16) score += 1;
		if (length >= 20) score += 1;

		// Character variety scoring
		if (/[a-z]/.test(password)) score += 1;
		if (/[A-Z]/.test(password)) score += 1;
		if (/[0-9]/.test(password)) score += 1;
		if (/[^a-zA-Z0-9]/.test(password)) score += 1;

		const percentage = (score / 8) * 100;

		if (percentage < 40)
			return { score: percentage, label: "Weak", color: "#ef4444" };
		if (percentage < 60)
			return { score: percentage, label: "Fair", color: "#f97316" };
		if (percentage < 80)
			return { score: percentage, label: "Good", color: "#eab308" };
		return { score: percentage, label: "Strong", color: "#22c55e" };
	};

	const strength = getPasswordStrength();

	// At least one option must be enabled
	const canToggleOption =
		[
			options.lowercase,
			options.uppercase,
			options.numbers,
			options.symbols,
		].filter(Boolean).length > 1;

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
				setCopied(false);
			}}
		>
			<BottomSheet.Trigger asChild>{children}</BottomSheet.Trigger>
			<BottomSheet.Portal>
				<BottomSheet.Overlay />
				<BottomSheet.Content snapPoints={["90%"]}>
					{/* Header */}
					<View className="mb-4 flex-row items-center justify-center gap-2">
						<StyledSparkles size={24} className="text-accent" />
						<BottomSheet.Title className="text-xl">
							Password Generator
						</BottomSheet.Title>
					</View>

					<BottomSheetScrollView className="flex-1 px-4">
						{/* Password Type Selector */}
						<View className="mb-4">
							<Text className="mb-2 font-medium text-foreground text-sm">
								Password Type
							</Text>
							<View className="flex-row gap-2">
								<Button
									variant={passwordType === "random" ? "primary" : "secondary"}
									onPress={() => {
										setPasswordType("random");
										if (isOpen) {
											setPassword(generatePassword(options));
										}
									}}
									className="flex-1"
								>
									Random
								</Button>
								<Button
									variant={
										passwordType === "memorable" ? "primary" : "secondary"
									}
									onPress={() => {
										setPasswordType("memorable");
										if (isOpen) {
											setPassword(
												generateMemorablePassword(wordCount, includeNumber),
											);
										}
									}}
									className="flex-1"
								>
									Memorable
								</Button>
							</View>
						</View>

						{/* Generated Password Display */}
						<View className="mb-4">
							<Text className="mb-2 font-medium text-foreground text-sm">
								Generated Password
							</Text>
							<View className="flex-row items-center gap-2">
								<View className="flex-1 rounded-xl border border-border bg-surface-secondary px-4 py-3">
									<Text
										className="font-mono text-foreground text-sm"
										selectable
										numberOfLines={2}
									>
										{password}
									</Text>
								</View>
								<Button isIconOnly variant="secondary" onPress={handleGenerate}>
									<StyledRefreshCw size={20} className="text-foreground" />
								</Button>
								<Button isIconOnly variant="secondary" onPress={handleCopy}>
									{copied ? (
										<StyledCheck size={20} className="text-success" />
									) : (
										<StyledCopy size={20} className="text-foreground" />
									)}
								</Button>
							</View>
						</View>

						{/* Password Strength Indicator */}
						<View className="mb-4 rounded-xl border border-border bg-surface-secondary p-3">
							<View className="flex-row items-center justify-between">
								<Text className="text-muted text-sm">Strength</Text>
								<Text
									className="font-semibold text-sm"
									style={{ color: strength.color }}
								>
									{strength.label}
								</Text>
							</View>
							<View className="mt-2 h-2 overflow-hidden rounded-full bg-surface">
								<View
									className="h-full rounded-full"
									style={{
										width: `${strength.score}%`,
										backgroundColor: strength.color,
									}}
								/>
							</View>
						</View>

						{/* Random Password Options */}
						{passwordType === "random" && (
							<View className="mb-4 gap-4">
								{/* Length Slider */}
								<View>
									<View className="mb-2 flex-row items-center justify-between">
										<Text className="font-medium text-foreground text-sm">
											Length
										</Text>
										<TextField className="w-16">
											<Input
												className="px-2 py-1 text-center"
												value={options.length.toString()}
												onChangeText={(text) => {
													const num = Number.parseInt(text, 10);
													if (!Number.isNaN(num) && num >= 8 && num <= 64) {
														updateOption("length", num);
													}
												}}
												keyboardType="numeric"
												selectTextOnFocus
											/>
										</TextField>
									</View>
									<View className="flex-row items-center gap-2">
										<Text className="text-muted text-xs">8</Text>
										<Slider
											style={{ flex: 1, height: 40 }}
											minimumValue={8}
											maximumValue={64}
											step={1}
											value={options.length}
											onValueChange={(value) => {
												updateOption("length", Math.round(value));
											}}
											minimumTrackTintColor="#6366f1"
											maximumTrackTintColor="#e5e7eb"
											thumbTintColor="#6366f1"
										/>
										<Text className="text-muted text-xs">64</Text>
									</View>
								</View>

								{/* Character Type Options */}
								<View>
									<Text className="mb-2 font-medium text-foreground text-sm">
										Include Characters
									</Text>
									<View className="gap-0 overflow-hidden rounded-xl border border-border">
										<ControlField
											isSelected={options.lowercase}
											onSelectedChange={(value) => {
												if (canToggleOption || value) {
													updateOption("lowercase", value);
												}
											}}
											isDisabled={!canToggleOption && options.lowercase}
											className="px-4 py-3"
										>
											<Label className="flex-1">Lowercase (a-z)</Label>
											<ControlField.Indicator>
												<Switch />
											</ControlField.Indicator>
										</ControlField>

										<ControlField
											isSelected={options.uppercase}
											onSelectedChange={(value) => {
												if (canToggleOption || value) {
													updateOption("uppercase", value);
												}
											}}
											isDisabled={!canToggleOption && options.uppercase}
											className="px-4 py-3"
										>
											<Label className="flex-1">Uppercase (A-Z)</Label>
											<ControlField.Indicator>
												<Switch />
											</ControlField.Indicator>
										</ControlField>

										<ControlField
											isSelected={options.numbers}
											onSelectedChange={(value) => {
												if (canToggleOption || value) {
													updateOption("numbers", value);
												}
											}}
											isDisabled={!canToggleOption && options.numbers}
											className="px-4 py-3"
										>
											<Label className="flex-1">Numbers (0-9)</Label>
											<ControlField.Indicator>
												<Switch />
											</ControlField.Indicator>
										</ControlField>

										<ControlField
											isSelected={options.symbols}
											onSelectedChange={(value) => {
												if (canToggleOption || value) {
													updateOption("symbols", value);
												}
											}}
											isDisabled={!canToggleOption && options.symbols}
											className="px-4 py-3"
										>
											<Label className="flex-1">Symbols (!@#$%...)</Label>
											<ControlField.Indicator>
												<Switch />
											</ControlField.Indicator>
										</ControlField>
									</View>
								</View>
							</View>
						)}

						{/* Memorable Password Options */}
						{passwordType === "memorable" && (
							<View className="mb-4 gap-4">
								<View>
									<Text className="mb-2 font-medium text-foreground text-sm">
										Number of Words
									</Text>
									<View className="flex-row gap-2">
										{[3, 4, 5, 6].map((count) => (
											<Button
												key={count}
												variant={wordCount === count ? "primary" : "secondary"}
												onPress={() => {
													setWordCount(count);
													if (isOpen && passwordType === "memorable") {
														setPassword(
															generateMemorablePassword(count, includeNumber),
														);
													}
												}}
												className="flex-1"
											>
												{count}
											</Button>
										))}
									</View>
								</View>

								<View className="overflow-hidden rounded-xl border border-border">
									<ControlField
										isSelected={includeNumber}
										onSelectedChange={(value) => {
											setIncludeNumber(value);
											if (isOpen && passwordType === "memorable") {
												setPassword(
													generateMemorablePassword(wordCount, value),
												);
											}
										}}
										className="px-4 py-3"
									>
										<Label className="flex-1">Include number at end</Label>
										<ControlField.Indicator>
											<Switch />
										</ControlField.Indicator>
									</ControlField>
								</View>

								<View className="rounded-xl bg-surface-secondary p-4">
									<Text className="text-muted text-sm">
										Memorable passwords use word combinations that are easier to
										remember while still being secure. Example:
										"Brave-Tiger-Golden-Phoenix-42"
									</Text>
								</View>
							</View>
						)}

						{/* Bottom padding */}
						<View className="h-4" />
					</BottomSheetScrollView>

					{/* Bottom Action Button */}
					<View className="border-border border-t px-4 py-4">
						<Button
							variant="primary"
							onPress={handleUse}
							isDisabled={!password}
							size="lg"
							className="w-full"
						>
							Use This Password
						</Button>
					</View>
				</BottomSheet.Content>
			</BottomSheet.Portal>
		</BottomSheet>
	);
}
