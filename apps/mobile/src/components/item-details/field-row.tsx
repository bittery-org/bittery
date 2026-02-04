import { Button, Card } from "heroui-native";
import { Copy, Eye, EyeOff } from "lucide-react-native";
import { View } from "react-native";
import { withUniwind } from "uniwind";
import type { FieldRowOptions } from "./types";
import { maskValue } from "./utils";

const StyledCopy = withUniwind(Copy);
const StyledEye = withUniwind(Eye);
const StyledEyeOff = withUniwind(EyeOff);

interface FieldRowProps {
	label: string;
	value: string | undefined;
	onCopy: (value: string, label: string) => Promise<void>;
	options?: FieldRowOptions;
}

export function FieldRow({ label, value, onCopy, options }: FieldRowProps) {
	if (!value) return null;

	const displayValue =
		options?.masked && !options?.showState ? maskValue(value) : value;

	return (
		<Card variant="default" className="mb-2">
			<Card.Body className="py-1">
				<Card.Description className="mb-1.5">{label}</Card.Description>
				<View className="flex-row items-center gap-2.5">
					{options?.icon && <options.icon size={16} className="text-muted" />}
					<Card.Title
						className="flex-1 font-normal text-base"
						selectable
						numberOfLines={
							options?.masked && !options?.showState ? 1 : undefined
						}
					>
						{displayValue}
					</Card.Title>
					{options?.masked && options?.setShowState && (
						<Button
							isIconOnly
							size="sm"
							variant="ghost"
							onPress={() => options.setShowState?.(!options.showState)}
						>
							{options.showState ? (
								<StyledEyeOff size={18} className="text-muted" />
							) : (
								<StyledEye size={18} className="text-muted" />
							)}
						</Button>
					)}
					<Button
						isIconOnly
						size="sm"
						variant="ghost"
						onPress={() => onCopy(value, label)}
					>
						<StyledCopy size={18} className="text-muted" />
					</Button>
				</View>
			</Card.Body>
		</Card>
	);
}
