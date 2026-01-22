import {
	generatePassword,
	type PasswordOptions,
} from "@bittery/shared/password";
import Slider from "@react-native-community/slider";
import * as Clipboard from "expo-clipboard";
import { Check, Copy, RefreshCw, Sparkles, X } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import {
	Modal,
	ScrollView,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";

interface PasswordGeneratorProps {
	visible: boolean;
	onClose: () => void;
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
	const randomValues = new Uint8Array(wordCount + 1);
	crypto.getRandomValues(randomValues);

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
	visible,
	onClose,
	onPasswordGenerated,
	defaultOptions,
}: PasswordGeneratorProps) {
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
			onClose();
		}
	};

	const updateOption = <K extends keyof PasswordOptions>(
		key: K,
		value: PasswordOptions[K],
	) => {
		setOptions((prev) => ({ ...prev, [key]: value }));
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

	// Generate initial password when modal opens
	useEffect(() => {
		if (visible && !password) {
			handleGenerate();
		}
	}, [visible, handleGenerate, password]);

	// Regenerate when password type or options change
	// biome-ignore lint/correctness/useExhaustiveDependencies: Intentionally regenerate when these specific options change
	useEffect(() => {
		if (visible) {
			handleGenerate();
		}
	}, [passwordType, wordCount, includeNumber, visible, handleGenerate]);

	// Reset state when modal closes
	useEffect(() => {
		if (!visible) {
			setPassword("");
			setCopied(false);
		}
	}, [visible]);

	// At least one option must be enabled
	const canToggleOption =
		[
			options.lowercase,
			options.uppercase,
			options.numbers,
			options.symbols,
		].filter(Boolean).length > 1;

	const renderCheckbox = (
		label: string,
		checked: boolean,
		onToggle: (value: boolean) => void,
		disabled?: boolean,
	) => (
		<TouchableOpacity
			onPress={() => {
				if (!disabled) {
					onToggle(!checked);
					// Regenerate after toggle
					setTimeout(handleGenerate, 0);
				}
			}}
			className="flex-row items-center justify-between py-2"
			disabled={disabled}
		>
			<Text
				className={`text-sm ${disabled ? "text-muted-foreground" : "text-foreground"}`}
			>
				{label}
			</Text>
			<View
				className={`h-5 w-5 items-center justify-center rounded border ${
					checked ? "border-primary bg-primary" : "border-input bg-background"
				} ${disabled ? "opacity-50" : ""}`}
			>
				{checked && <Check size={14} color="#fff" />}
			</View>
		</TouchableOpacity>
	);

	return (
		<Modal
			visible={visible}
			animationType="slide"
			presentationStyle="pageSheet"
			onRequestClose={onClose}
		>
			<View className="flex-1 bg-background">
				{/* Header */}
				<View className="flex-row items-center justify-between border-border border-b px-4 py-4">
					<View className="flex-row items-center">
						<Sparkles size={24} color="#6b7280" />
						<Text className="ml-2 font-bold text-foreground text-xl">
							Password Generator
						</Text>
					</View>
					<TouchableOpacity
						onPress={onClose}
						className="rounded-full bg-secondary p-2"
					>
						<X size={20} color="#6b7280" />
					</TouchableOpacity>
				</View>

				<ScrollView className="flex-1 px-4" keyboardShouldPersistTaps="handled">
					{/* Password Type Selector */}
					<View className="my-4">
						<Text className="mb-2 font-medium text-foreground text-sm">
							Password Type
						</Text>
						<View className="flex-row rounded-lg border border-input bg-background">
							<TouchableOpacity
								onPress={() => setPasswordType("random")}
								className={`flex-1 items-center py-3 ${
									passwordType === "random" ? "bg-primary" : ""
								} rounded-l-lg`}
							>
								<Text
									className={`font-medium text-sm ${
										passwordType === "random"
											? "text-primary-foreground"
											: "text-foreground"
									}`}
								>
									Random
								</Text>
							</TouchableOpacity>
							<TouchableOpacity
								onPress={() => setPasswordType("memorable")}
								className={`flex-1 items-center py-3 ${
									passwordType === "memorable" ? "bg-primary" : ""
								} rounded-r-lg`}
							>
								<Text
									className={`font-medium text-sm ${
										passwordType === "memorable"
											? "text-primary-foreground"
											: "text-foreground"
									}`}
								>
									Memorable
								</Text>
							</TouchableOpacity>
						</View>
					</View>

					{/* Generated Password Display */}
					<View className="mb-4">
						<Text className="mb-2 font-medium text-foreground text-sm">
							Generated Password
						</Text>
						<View className="flex-row items-center gap-2">
							<View className="flex-1 rounded-lg border border-input bg-secondary/30 px-4 py-3">
								<Text
									className="font-mono text-foreground text-sm"
									selectable
									numberOfLines={2}
								>
									{password}
								</Text>
							</View>
							<TouchableOpacity
								onPress={handleGenerate}
								className="rounded-lg border border-input bg-background p-3"
							>
								<RefreshCw size={20} color="#6b7280" />
							</TouchableOpacity>
							<TouchableOpacity
								onPress={handleCopy}
								className="rounded-lg border border-input bg-background p-3"
							>
								{copied ? (
									<Check size={20} color="#22c55e" />
								) : (
									<Copy size={20} color="#6b7280" />
								)}
							</TouchableOpacity>
						</View>
					</View>

					{/* Password Strength Indicator */}
					<View className="mb-4">
						<View className="flex-row items-center justify-between">
							<Text className="text-muted-foreground text-sm">Strength:</Text>
							<Text
								className="font-medium text-sm"
								style={{ color: strength.color }}
							>
								{strength.label}
							</Text>
						</View>
						<View className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
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
						<>
							{/* Length Slider */}
							<View className="mb-4">
								<View className="flex-row items-center justify-between">
									<Text className="font-medium text-foreground text-sm">
										Length
									</Text>
									<View className="flex-row items-center">
										<TextInput
											className="w-12 rounded-lg border border-input bg-background px-2 py-1 text-center text-foreground"
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
									</View>
								</View>
								<View className="mt-2 flex-row items-center">
									<Text className="mr-2 text-muted-foreground text-xs">8</Text>
									<Slider
										style={{ flex: 1, height: 40 }}
										minimumValue={8}
										maximumValue={64}
										step={1}
										value={options.length}
										onValueChange={(value) => {
											updateOption("length", Math.round(value));
										}}
										onSlidingComplete={() => {
											handleGenerate();
										}}
										minimumTrackTintColor="#6366f1"
										maximumTrackTintColor="#e5e7eb"
										thumbTintColor="#6366f1"
									/>
									<Text className="ml-2 text-muted-foreground text-xs">64</Text>
								</View>
							</View>

							{/* Character Type Options */}
							<View className="mb-4">
								<Text className="mb-2 font-medium text-foreground text-sm">
									Include Characters
								</Text>
								<View className="rounded-lg border border-border bg-background px-4">
									{renderCheckbox(
										"Lowercase (a-z)",
										options.lowercase,
										(value) => {
											if (canToggleOption || value) {
												updateOption("lowercase", value);
											}
										},
										!canToggleOption && options.lowercase,
									)}
									{renderCheckbox(
										"Uppercase (A-Z)",
										options.uppercase,
										(value) => {
											if (canToggleOption || value) {
												updateOption("uppercase", value);
											}
										},
										!canToggleOption && options.uppercase,
									)}
									{renderCheckbox(
										"Numbers (0-9)",
										options.numbers,
										(value) => {
											if (canToggleOption || value) {
												updateOption("numbers", value);
											}
										},
										!canToggleOption && options.numbers,
									)}
									{renderCheckbox(
										"Symbols (!@#$%...)",
										options.symbols,
										(value) => {
											if (canToggleOption || value) {
												updateOption("symbols", value);
											}
										},
										!canToggleOption && options.symbols,
									)}
								</View>
							</View>
						</>
					)}

					{/* Memorable Password Options */}
					{passwordType === "memorable" && (
						<>
							<View className="mb-4">
								<Text className="mb-2 font-medium text-foreground text-sm">
									Number of Words
								</Text>
								<View className="flex-row rounded-lg border border-input bg-background">
									{[3, 4, 5, 6].map((count) => (
										<TouchableOpacity
											key={count}
											onPress={() => setWordCount(count)}
											className={`flex-1 items-center py-3 ${
												wordCount === count ? "bg-primary" : ""
											} ${count === 3 ? "rounded-l-lg" : ""} ${
												count === 6 ? "rounded-r-lg" : ""
											}`}
										>
											<Text
												className={`font-medium text-sm ${
													wordCount === count
														? "text-primary-foreground"
														: "text-foreground"
												}`}
											>
												{count}
											</Text>
										</TouchableOpacity>
									))}
								</View>
							</View>

							<View className="mb-4">
								<View className="rounded-lg border border-border bg-background px-4">
									{renderCheckbox(
										"Include number at end",
										includeNumber,
										setIncludeNumber,
									)}
								</View>
							</View>

							<View className="mb-4 rounded-lg bg-secondary/50 p-4">
								<Text className="text-muted-foreground text-sm">
									Memorable passwords use word combinations that are easier to
									remember while still being secure. Example:
									"Brave-Tiger-Golden-Phoenix-42"
								</Text>
							</View>
						</>
					)}

					{/* Bottom padding */}
					<View className="h-4" />
				</ScrollView>

				{/* Bottom Action Button */}
				<View className="border-border border-t px-4 py-4">
					<TouchableOpacity
						onPress={handleUse}
						disabled={!password}
						className={`rounded-lg py-4 ${
							password ? "bg-primary" : "bg-primary/50"
						}`}
					>
						<Text className="text-center font-semibold text-base text-primary-foreground">
							Use This Password
						</Text>
					</TouchableOpacity>
				</View>
			</View>
		</Modal>
	);
}
