import type { PasswordHistoryEntry } from "@bittery/shared/types";
import { Button } from "heroui-native";
import { Copy, History, RotateCcw, X } from "lucide-react-native";
import { useMemo } from "react";
import {
	Alert,
	Modal,
	Pressable,
	ScrollView,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { withUniwind } from "uniwind";

const StyledCopy = withUniwind(Copy);
const StyledHistory = withUniwind(History);
const StyledRotateCcw = withUniwind(RotateCcw);
const StyledX = withUniwind(X);

interface PasswordHistorySheetProps {
	visible: boolean;
	onClose: () => void;
	passwordHistory?: PasswordHistoryEntry[];
	currentPassword?: string;
	onCopyPassword: (password: string) => Promise<void>;
	onRestorePassword: (password: string) => Promise<void>;
	isRestoring?: boolean;
}

function formatChangedAt(value: string): string {
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return value;
	}

	return new Date(timestamp).toLocaleString();
}

function maskPassword(password: string): string {
	return "\u2022".repeat(Math.max(8, Math.min(16, password.length)));
}

export function PasswordHistorySheet({
	visible,
	onClose,
	passwordHistory,
	currentPassword,
	onCopyPassword,
	onRestorePassword,
	isRestoring = false,
}: PasswordHistorySheetProps) {
	const sortedHistory = useMemo(() => {
		return [...(passwordHistory ?? [])].sort((left, right) => {
			const leftTs = Date.parse(left.changedAt);
			const rightTs = Date.parse(right.changedAt);

			if (Number.isNaN(leftTs) && Number.isNaN(rightTs)) {
				return 0;
			}
			if (Number.isNaN(leftTs)) {
				return 1;
			}
			if (Number.isNaN(rightTs)) {
				return -1;
			}

			return rightTs - leftTs;
		});
	}, [passwordHistory]);

	const handleClose = () => {
		if (!isRestoring) {
			onClose();
		}
	};

	const handleRestorePress = (password: string) => {
		Alert.alert(
			"Restore Password",
			"Restore this password? The current password will be archived automatically.",
			[
				{
					text: "Cancel",
					style: "cancel",
				},
				{
					text: "Restore",
					style: "destructive",
					onPress: () => {
						void onRestorePassword(password);
					},
				},
			],
		);
	};

	return (
		<Modal
			visible={visible}
			transparent
			animationType="slide"
			onRequestClose={handleClose}
		>
			<View className="flex-1 justify-end bg-black/50">
				<Pressable className="flex-1" onPress={handleClose} />
				<View className="max-h-[85%] rounded-t-2xl bg-background px-4 pt-4 pb-8">
					<View className="mb-4 flex-row items-center justify-between">
						<View className="flex-row items-center gap-2">
							<StyledHistory size={20} className="text-foreground" />
							<Text className="font-semibold text-foreground text-lg">
								Password History
							</Text>
						</View>
						<TouchableOpacity onPress={handleClose} disabled={isRestoring}>
							<StyledX size={24} className="text-muted" />
						</TouchableOpacity>
					</View>

					<Text className="mb-4 text-muted text-sm">
						View previous passwords and restore one when needed.
					</Text>

					{sortedHistory.length === 0 ? (
						<View className="rounded-lg bg-card p-4">
							<Text className="text-center text-muted text-sm">
								No previous passwords saved yet.
							</Text>
						</View>
					) : (
						<ScrollView
							className="max-h-[60%]"
							showsVerticalScrollIndicator={false}
						>
							<View className="gap-2">
								{sortedHistory.map((historyEntry) => {
									const isCurrent = historyEntry.password === currentPassword;
									return (
										<View
											key={`${historyEntry.password}-${historyEntry.changedAt}`}
											className="rounded-lg border border-border bg-card p-3"
										>
											<Text className="font-medium text-foreground text-sm">
												{formatChangedAt(historyEntry.changedAt)}
											</Text>
											<Text className="mb-3 font-mono text-muted text-xs">
												{maskPassword(historyEntry.password)}
											</Text>
											<View className="flex-row gap-2">
												<Button
													variant="ghost"
													size="sm"
													className="flex-1"
													onPress={() => {
														void onCopyPassword(historyEntry.password);
													}}
												>
													<StyledCopy size={16} className="text-current" />
													<Button.Label>Copy</Button.Label>
												</Button>
												<Button
													variant={isCurrent ? "secondary" : "primary"}
													size="sm"
													className="flex-1"
													onPress={() =>
														handleRestorePress(historyEntry.password)
													}
													isDisabled={isCurrent || isRestoring}
												>
													<StyledRotateCcw
														size={16}
														className={
															isCurrent
																? "text-muted"
																: "text-primary-foreground"
														}
													/>
													<Button.Label>
														{isCurrent
															? "Current"
															: isRestoring
																? "Restoring..."
																: "Restore"}
													</Button.Label>
												</Button>
											</View>
										</View>
									);
								})}
							</View>
						</ScrollView>
					)}
				</View>
			</View>
		</Modal>
	);
}
