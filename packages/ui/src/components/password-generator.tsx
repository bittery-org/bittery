import {
	copyToClipboard,
	generatePassword,
	type PasswordOptions,
} from "@bittery/shared/password";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

interface PasswordGeneratorProps {
	onPasswordGenerated?: (password: string) => void;
	defaultOptions?: PasswordOptions;
	triggerButton?: React.ReactNode;
	showCopyButton?: boolean;
}

export function PasswordGenerator({
	onPasswordGenerated,
	defaultOptions,
	triggerButton,
	showCopyButton = true,
}: PasswordGeneratorProps) {
	const [password, setPassword] = useState("");
	const [copied, setCopied] = useState(false);
	const [isOpen, setIsOpen] = useState(false);
	const [options, setOptions] = useState<PasswordOptions>({
		length: defaultOptions?.length ?? 20,
		lowercase: defaultOptions?.lowercase ?? true,
		uppercase: defaultOptions?.uppercase ?? true,
		numbers: defaultOptions?.numbers ?? true,
		symbols: defaultOptions?.symbols ?? true,
	});

	const handleGenerate = useCallback(() => {
		const newPassword = generatePassword(options);
		setPassword(newPassword);
		if (onPasswordGenerated) {
			onPasswordGenerated(newPassword);
		}
	}, [options, onPasswordGenerated]);

	const handleCopy = async () => {
		if (password) {
			await copyToClipboard(password);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const handleUse = () => {
		if (onPasswordGenerated && password) {
			onPasswordGenerated(password);
			setIsOpen(false);
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
		if (!password) return { score: 0, label: "None", color: "bg-gray-300" };

		let score = 0;
		const length = password.length;

		// Length scoring
		if (length >= 8) score += 1;
		if (length >= 12) score += 1;
		if (length >= 16) score += 1;
		if (length >= 20) score += 1;

		// Character variety scoring
		if (options.lowercase) score += 1;
		if (options.uppercase) score += 1;
		if (options.numbers) score += 1;
		if (options.symbols) score += 1;

		const percentage = (score / 8) * 100;

		if (percentage < 40)
			return { score: percentage, label: "Weak", color: "bg-red-500" };
		if (percentage < 60)
			return { score: percentage, label: "Fair", color: "bg-orange-500" };
		if (percentage < 80)
			return { score: percentage, label: "Good", color: "bg-yellow-500" };
		return { score: percentage, label: "Strong", color: "bg-green-500" };
	};

	const strength = getPasswordStrength();

	// Generate initial password
	useEffect(() => {
		if (isOpen && !password) {
			handleGenerate();
		}
	}, [isOpen, handleGenerate, password]);

	// At least one option must be enabled
	const canToggleOption =
		[
			options.lowercase,
			options.uppercase,
			options.numbers,
			options.symbols,
		].filter(Boolean).length > 1;

	return (
		<Popover modal open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger asChild>
				{triggerButton || (
					<Button type="button" variant="outline" size="icon">
						<RefreshCw size={16} />
					</Button>
				)}
			</PopoverTrigger>
			<PopoverContent className="w-80" align="start" side="left">
				<div className="space-y-4">
					<div className="space-y-2">
						<Label className="font-semibold text-base">
							Password Generator
						</Label>
						<p className="text-muted-foreground text-xs">
							Generate a secure password with custom settings
						</p>
					</div>

					{/* Generated Password Display */}
					<div className="space-y-2">
						<Label>Generated Password</Label>
						<div className="flex gap-2">
							<Input
								type="text"
								value={password}
								readOnly
								className="flex-1 font-mono text-sm"
							/>
							<Button
								type="button"
								variant="outline"
								size="icon"
								onClick={handleGenerate}
								title="Regenerate"
							>
								<RefreshCw size={16} />
							</Button>
							{showCopyButton && (
								<Button
									type="button"
									variant="outline"
									size="icon"
									onClick={handleCopy}
									title="Copy to clipboard"
								>
									{copied ? <Check size={16} /> : <Copy size={16} />}
								</Button>
							)}
						</div>
					</div>

					{/* Password Strength Indicator */}
					<div className="space-y-2">
						<div className="flex items-center justify-between text-sm">
							<span className="text-muted-foreground">Strength:</span>
							<span className="font-medium">{strength.label}</span>
						</div>
						<div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
							<div
								className={`h-full transition-all duration-300 ${strength.color}`}
								style={{ width: `${strength.score}%` }}
							/>
						</div>
					</div>

					{/* Length Slider */}
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<Label>Length</Label>
							<span className="font-medium text-sm">{options.length}</span>
						</div>
						<input
							type="range"
							min="8"
							max="64"
							value={options.length}
							onChange={(e) =>
								updateOption("length", Number.parseInt(e.target.value, 10))
							}
							onMouseUp={handleGenerate}
							onTouchEnd={handleGenerate}
							className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 accent-primary"
						/>
						<div className="flex justify-between text-muted-foreground text-xs">
							<span>8</span>
							<span>64</span>
						</div>
					</div>

					{/* Character Type Options */}
					<div className="space-y-3">
						<Label>Include Characters</Label>
						<div className="space-y-2">
							<label className="flex cursor-pointer items-center justify-between">
								<span className="text-sm">Lowercase (a-z)</span>
								<input
									type="checkbox"
									checked={options.lowercase}
									onChange={(e) => {
										if (canToggleOption || e.target.checked) {
											updateOption("lowercase", e.target.checked);
										}
									}}
									onBlur={handleGenerate}
									className="size-4 cursor-pointer rounded border-gray-300 accent-primary"
								/>
							</label>
							<label className="flex cursor-pointer items-center justify-between">
								<span className="text-sm">Uppercase (A-Z)</span>
								<input
									type="checkbox"
									checked={options.uppercase}
									onChange={(e) => {
										if (canToggleOption || e.target.checked) {
											updateOption("uppercase", e.target.checked);
										}
									}}
									onBlur={handleGenerate}
									className="size-4 cursor-pointer rounded border-gray-300 accent-primary"
								/>
							</label>
							<label className="flex cursor-pointer items-center justify-between">
								<span className="text-sm">Numbers (0-9)</span>
								<input
									type="checkbox"
									checked={options.numbers}
									onChange={(e) => {
										if (canToggleOption || e.target.checked) {
											updateOption("numbers", e.target.checked);
										}
									}}
									onBlur={handleGenerate}
									className="size-4 cursor-pointer rounded border-gray-300 accent-primary"
								/>
							</label>
							<label className="flex cursor-pointer items-center justify-between">
								<span className="text-sm">Symbols (!@#$%...)</span>
								<input
									type="checkbox"
									checked={options.symbols}
									onChange={(e) => {
										if (canToggleOption || e.target.checked) {
											updateOption("symbols", e.target.checked);
										}
									}}
									onBlur={handleGenerate}
									className="size-4 cursor-pointer rounded border-gray-300 accent-primary"
								/>
							</label>
						</div>
					</div>

					{/* Action Buttons */}
					{onPasswordGenerated && (
						<Button
							type="button"
							onClick={handleUse}
							className="w-full"
							disabled={!password}
						>
							Use This Password
						</Button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
