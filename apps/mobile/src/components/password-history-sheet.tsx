import type { PasswordHistoryEntry } from "@bittery/shared/types";
import { PressableFeedback } from "heroui-native";
import { useMemo } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import {
	BrandButton,
	IconCopy,
	IconHistory,
	IconRotateCcw,
	iconSize,
	ListCard,
} from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";
import { SheetModal } from "./sheet-modal";

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
	return "•".repeat(Math.max(8, Math.min(16, password.length)));
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
	const { m } = useI18n();
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

	const handleRestorePress = (password: string) => {
		Alert.alert(
			m.mob_password_history_restore_dialog_title(),
			m.mob_password_history_restore_dialog_message(),
			[
				{
					text: m.mob_password_history_restore_dialog_cancel(),
					style: "cancel",
				},
				{
					text: m.mob_password_history_restore_dialog_confirm(),
					style: "destructive",
					onPress: () => {
						void onRestorePassword(password);
					},
				},
			],
		);
	};

	return (
		<SheetModal
			visible={visible}
			onClose={onClose}
			isBusy={isRestoring}
			icon={IconHistory}
			title={m.mob_password_history_title()}
			description={m.mob_password_history_description()}
		>
			{sortedHistory.length === 0 ? (
				<View className="px-4 pb-4">
					<ListCard>
						<View className="px-4 py-6">
							<Text className="text-center text-muted text-sm">
								{m.mob_password_history_empty()}
							</Text>
						</View>
					</ListCard>
				</View>
			) : (
				<ScrollView
					className="max-h-[60%]"
					contentContainerClassName="gap-3 px-4 pb-4"
					showsVerticalScrollIndicator={false}
				>
					{sortedHistory.map((historyEntry) => {
						const isCurrent = historyEntry.password === currentPassword;
						return (
							<View
								key={`${historyEntry.password}-${historyEntry.changedAt}`}
								className="rounded-2xl border border-border bg-surface p-4"
							>
								<Text className="font-medium text-base text-foreground">
									{formatChangedAt(historyEntry.changedAt)}
								</Text>
								<Text className="mt-1 font-mono text-muted text-sm">
									{maskPassword(historyEntry.password)}
								</Text>
								<View className="mt-3 flex-row gap-2">
									<PressableFeedback
										onPress={() => {
											void onCopyPassword(historyEntry.password);
										}}
										accessibilityRole="button"
										accessibilityLabel={m.mob_password_history_copy()}
										className="h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl border border-border bg-surface-tertiary"
									>
										<PressableFeedback.Highlight />
										<IconCopy
											size={iconSize.chip}
											className="text-foreground"
										/>
										<Text className="font-medium text-foreground text-sm">
											{m.mob_password_history_copy()}
										</Text>
									</PressableFeedback>
									{isCurrent ? (
										<View className="h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl border border-accent/15 bg-selected">
											<Text className="font-medium text-accent text-sm">
												{m.mob_password_history_current()}
											</Text>
										</View>
									) : (
										<BrandButton
											label={
												isRestoring
													? m.mob_password_history_restoring()
													: m.mob_password_history_restore()
											}
											onPress={() => handleRestorePress(historyEntry.password)}
											isDisabled={isRestoring}
											fullWidth={false}
											leading={
												<IconRotateCcw
													size={iconSize.chip}
													className="text-accent-foreground"
												/>
											}
											className="h-11 flex-1"
										/>
									)}
								</View>
							</View>
						);
					})}
				</ScrollView>
			)}
		</SheetModal>
	);
}
