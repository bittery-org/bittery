/**
 * Conflict Resolution Modal
 * Allows users to resolve sync conflicts by choosing local or server version
 */

import type { SyncConflict } from "@bittery/sync";
import {
	AlertTriangle,
	ArrowRight,
	Cloud,
	Phone,
	Trash2,
	X,
} from "lucide-react-native";
import { useState } from "react";
import {
	ActivityIndicator,
	Modal,
	ScrollView,
	Text,
	TouchableOpacity,
	View,
} from "react-native";

interface ConflictResolutionModalProps {
	visible: boolean;
	conflict: SyncConflict | null;
	localItemTitle: string;
	serverItemTitle: string;
	onResolveKeepLocal: () => Promise<void>;
	onResolveKeepServer: () => Promise<void>;
	onDismiss: () => void;
}

export function ConflictResolutionModal({
	visible,
	conflict,
	localItemTitle,
	serverItemTitle,
	onResolveKeepLocal,
	onResolveKeepServer,
	onDismiss,
}: ConflictResolutionModalProps) {
	const [resolving, setResolving] = useState<"local" | "server" | null>(null);

	if (!conflict) return null;

	const isDeleteConflict = conflict.conflictType === "delete_conflict";

	const handleKeepLocal = async () => {
		setResolving("local");
		try {
			await onResolveKeepLocal();
		} finally {
			setResolving(null);
		}
	};

	const handleKeepServer = async () => {
		setResolving("server");
		try {
			await onResolveKeepServer();
		} finally {
			setResolving(null);
		}
	};

	const formatTimestamp = (timestamp: number | string) => {
		const date =
			typeof timestamp === "string" ? new Date(timestamp) : new Date(timestamp);
		return date.toLocaleString();
	};

	return (
		<Modal
			visible={visible}
			animationType="slide"
			transparent
			onRequestClose={onDismiss}
		>
			<View className="flex-1 justify-end bg-black/50">
				<View className="max-h-[85%] rounded-t-3xl bg-background">
					{/* Header */}
					<View className="flex-row items-center border-border border-b px-6 py-4">
						<View className="mr-3 rounded-full bg-red-100 p-2 dark:bg-red-900">
							<AlertTriangle size={20} color="#ef4444" />
						</View>
						<View className="flex-1">
							<Text className="font-bold text-foreground text-lg">
								Sync Conflict
							</Text>
							<Text className="text-muted text-sm">
								Choose which version to keep
							</Text>
						</View>
						<TouchableOpacity
							onPress={onDismiss}
							className="rounded-full bg-secondary p-2"
						>
							<X size={20} color="#6b7280" />
						</TouchableOpacity>
					</View>

					<ScrollView className="flex-1 p-6">
						{/* Conflict Description */}
						<View className="mb-6 rounded-lg bg-yellow-50 p-4 dark:bg-yellow-900/30">
							<Text className="font-medium text-yellow-800 dark:text-yellow-200">
								{isDeleteConflict
									? "This item was deleted on the server while you had local changes."
									: "This item was modified both locally and on the server."}
							</Text>
						</View>

						{/* Comparison Cards */}
						<View className="mb-6">
							{/* Local Version */}
							<View className="mb-4 rounded-lg border-2 border-blue-500 bg-blue-50 p-4 dark:bg-blue-900/30">
								<View className="mb-3 flex-row items-center">
									<Phone size={20} color="#3b82f6" />
									<Text className="ml-2 font-bold text-blue-700 dark:text-blue-300">
										Your Local Version
									</Text>
								</View>

								<View className="mb-2">
									<Text className="font-semibold text-foreground">
										{localItemTitle}
									</Text>
								</View>

								<View className="flex-row items-center justify-between">
									<Text className="text-muted text-sm">Modified locally</Text>
									<Text className="font-medium text-foreground text-sm">
										{formatTimestamp(conflict.localItem.updatedAt)}
									</Text>
								</View>

								<View className="mt-2 flex-row items-center justify-between">
									<Text className="text-muted text-sm">Local version</Text>
									<Text className="font-mono text-foreground text-sm">
										v{conflict.localItem.localVersion}
									</Text>
								</View>
							</View>

							{/* VS Divider */}
							<View className="my-2 flex-row items-center justify-center">
								<View className="h-px flex-1 bg-border" />
								<View className="mx-4 rounded-full bg-secondary px-4 py-1">
									<Text className="font-bold text-muted text-sm">VS</Text>
								</View>
								<View className="h-px flex-1 bg-border" />
							</View>

							{/* Server Version */}
							<View className="mt-4 rounded-lg border-2 border-green-500 bg-green-50 p-4 dark:bg-green-900/30">
								<View className="mb-3 flex-row items-center">
									{isDeleteConflict ? (
										<>
											<Trash2 size={20} color="#ef4444" />
											<Text className="ml-2 font-bold text-red-700 dark:text-red-300">
												Deleted on Server
											</Text>
										</>
									) : (
										<>
											<Cloud size={20} color="#22c55e" />
											<Text className="ml-2 font-bold text-green-700 dark:text-green-300">
												Server Version
											</Text>
										</>
									)}
								</View>

								{isDeleteConflict ? (
									<View className="mb-2">
										<Text className="text-muted italic">
											This item was deleted on another device
										</Text>
									</View>
								) : (
									<View className="mb-2">
										<Text className="font-semibold text-foreground">
											{serverItemTitle}
										</Text>
									</View>
								)}

								<View className="flex-row items-center justify-between">
									<Text className="text-muted text-sm">
										{isDeleteConflict ? "Deleted at" : "Modified at"}
									</Text>
									<Text className="font-medium text-foreground text-sm">
										{formatTimestamp(conflict.serverItem.updatedAt)}
									</Text>
								</View>

								{!isDeleteConflict && (
									<View className="mt-2 flex-row items-center justify-between">
										<Text className="text-muted text-sm">Server version</Text>
										<Text className="font-mono text-foreground text-sm">
											v{conflict.serverItem.version}
										</Text>
									</View>
								)}
							</View>
						</View>

						{/* Explanation */}
						<View className="mb-6">
							<Text className="mb-2 font-semibold text-foreground">
								What happens when you choose?
							</Text>

							<View className="mb-3 flex-row items-start">
								<View className="mt-1 mr-3 h-2 w-2 rounded-full bg-blue-500" />
								<Text className="flex-1 text-muted text-sm">
									<Text className="font-semibold text-foreground">
										Keep Local:
									</Text>{" "}
									{isDeleteConflict
										? "Your local changes will be uploaded and the item will be restored on the server."
										: "Your local changes will overwrite the server version."}
								</Text>
							</View>

							<View className="flex-row items-start">
								<View className="mt-1 mr-3 h-2 w-2 rounded-full bg-green-500" />
								<Text className="flex-1 text-muted text-sm">
									<Text className="font-semibold text-foreground">
										Keep Server:
									</Text>{" "}
									{isDeleteConflict
										? "The item will be deleted from your device as well."
										: "The server version will replace your local changes."}
								</Text>
							</View>
						</View>
					</ScrollView>

					{/* Action Buttons */}
					<View className="flex-row gap-3 border-border border-t p-6">
						<TouchableOpacity
							onPress={handleKeepLocal}
							disabled={resolving !== null}
							className={`flex-1 flex-row items-center justify-center rounded-lg border-2 border-blue-500 py-3 ${
								resolving === "local"
									? "bg-blue-500"
									: "bg-blue-50 dark:bg-blue-900/30"
							}`}
						>
							{resolving === "local" ? (
								<ActivityIndicator color="#fff" size="small" />
							) : (
								<>
									<Phone size={18} color="#3b82f6" />
									<Text className="ml-2 font-semibold text-blue-600 dark:text-blue-400">
										Keep Local
									</Text>
								</>
							)}
						</TouchableOpacity>

						<TouchableOpacity
							onPress={handleKeepServer}
							disabled={resolving !== null}
							className={`flex-1 flex-row items-center justify-center rounded-lg border-2 py-3 ${
								isDeleteConflict
									? "border-red-500 bg-red-50 dark:bg-red-900/30"
									: "border-green-500 bg-green-50 dark:bg-green-900/30"
							} ${resolving === "server" ? (isDeleteConflict ? "bg-red-500" : "bg-green-500") : ""}`}
						>
							{resolving === "server" ? (
								<ActivityIndicator color="#fff" size="small" />
							) : isDeleteConflict ? (
								<>
									<Trash2 size={18} color="#ef4444" />
									<Text className="ml-2 font-semibold text-red-600 dark:text-red-400">
										Delete
									</Text>
								</>
							) : (
								<>
									<Cloud size={18} color="#22c55e" />
									<Text className="ml-2 font-semibold text-green-600 dark:text-green-400">
										Keep Server
									</Text>
								</>
							)}
						</TouchableOpacity>
					</View>

					{/* Bottom safe area */}
					<View className="h-6" />
				</View>
			</View>
		</Modal>
	);
}

/**
 * Conflict list item for displaying multiple conflicts
 */
interface ConflictListItemProps {
	conflict: SyncConflict;
	itemTitle: string;
	onPress: () => void;
}

export function ConflictListItem({
	conflict,
	itemTitle,
	onPress,
}: ConflictListItemProps) {
	const isDeleteConflict = conflict.conflictType === "delete_conflict";

	return (
		<TouchableOpacity
			onPress={onPress}
			className="mb-2 flex-row items-center rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950"
		>
			<View className="mr-3 rounded-full bg-red-100 p-2 dark:bg-red-900">
				{isDeleteConflict ? (
					<Trash2 size={16} color="#ef4444" />
				) : (
					<AlertTriangle size={16} color="#ef4444" />
				)}
			</View>

			<View className="flex-1">
				<Text className="font-semibold text-foreground">{itemTitle}</Text>
				<Text className="text-red-600 text-sm dark:text-red-400">
					{isDeleteConflict ? "Deleted on server" : "Modified on both devices"}
				</Text>
			</View>

			<ArrowRight size={20} color="#6b7280" />
		</TouchableOpacity>
	);
}

/**
 * Conflicts summary card
 */
interface ConflictsSummaryProps {
	conflictsCount: number;
	onViewConflicts: () => void;
}

export function ConflictsSummary({
	conflictsCount,
	onViewConflicts,
}: ConflictsSummaryProps) {
	if (conflictsCount === 0) return null;

	return (
		<TouchableOpacity
			onPress={onViewConflicts}
			className="mx-4 mb-4 flex-row items-center rounded-lg bg-red-100 p-4 dark:bg-red-900/50"
		>
			<AlertTriangle size={24} color="#ef4444" />
			<View className="ml-3 flex-1">
				<Text className="font-semibold text-red-700 dark:text-red-300">
					{conflictsCount} Sync Conflict{conflictsCount > 1 ? "s" : ""}
				</Text>
				<Text className="text-red-600 text-sm dark:text-red-400">
					Tap to resolve
				</Text>
			</View>
			<View className="rounded-full bg-red-500 px-3 py-1">
				<Text className="font-bold text-white">{conflictsCount}</Text>
			</View>
		</TouchableOpacity>
	);
}
