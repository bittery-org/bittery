/**
 * Sync Status Indicator Component
 * Displays current sync status including offline mode, pending changes, and conflicts
 */

import {
	AlertCircle,
	AlertTriangle,
	Check,
	Cloud,
	CloudOff,
	RefreshCw,
	Upload,
	Wifi,
	WifiOff,
	X,
} from "lucide-react-native";
import { useCallback, useState } from "react";
import {
	ActivityIndicator,
	Modal,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { useOfflineVaultContext } from "../contexts/offline-vault-context";

/**
 * Compact sync status badge for headers
 */
export function SyncStatusBadge() {
	const { isOnline, status, hasConflicts } = useOfflineVaultContext();
	const [showDetails, setShowDetails] = useState(false);

	// Determine badge color and icon
	let badgeColor = "bg-green-500";
	let Icon = Check;
	let statusText = "Synced";

	if (!isOnline) {
		badgeColor = "bg-yellow-500";
		Icon = WifiOff;
		statusText = "Offline";
	} else if (hasConflicts) {
		badgeColor = "bg-red-500";
		Icon = AlertTriangle;
		statusText = "Conflicts";
	} else if (status.pendingChangesCount > 0) {
		badgeColor = "bg-blue-500";
		Icon = Upload;
		statusText = `${status.pendingChangesCount} pending`;
	} else if (status.isSyncing) {
		badgeColor = "bg-blue-500";
		Icon = RefreshCw;
		statusText = "Syncing...";
	}

	return (
		<>
			<TouchableOpacity
				onPress={() => setShowDetails(true)}
				className={`flex-row items-center rounded-full px-3 py-1.5 ${badgeColor}`}
			>
				<Icon size={14} color="#fff" />
				<Text className="ml-1.5 font-medium text-white text-xs">
					{statusText}
				</Text>
			</TouchableOpacity>

			<SyncStatusModal
				visible={showDetails}
				onClose={() => setShowDetails(false)}
			/>
		</>
	);
}

/**
 * Inline sync status for list headers
 */
export function SyncStatusInline() {
	const { isOnline, status, hasConflicts } = useOfflineVaultContext();

	if (isOnline && !hasConflicts && status.pendingChangesCount === 0) {
		return null; // Don't show anything when fully synced
	}

	return (
		<View className="flex-row items-center bg-secondary/50 px-4 py-2">
			{!isOnline ? (
				<>
					<WifiOff size={16} color="#eab308" />
					<Text className="ml-2 text-sm text-yellow-600">
						Offline Mode - Changes will sync when connected
					</Text>
				</>
			) : hasConflicts ? (
				<>
					<AlertTriangle size={16} color="#ef4444" />
					<Text className="ml-2 text-red-600 text-sm">
						{status.conflictsCount} sync conflict
						{status.conflictsCount > 1 ? "s" : ""} need resolution
					</Text>
				</>
			) : status.pendingChangesCount > 0 ? (
				<>
					<Upload size={16} color="#3b82f6" />
					<Text className="ml-2 text-blue-600 text-sm">
						{status.pendingChangesCount} change
						{status.pendingChangesCount > 1 ? "s" : ""} waiting to sync
					</Text>
				</>
			) : null}
		</View>
	);
}

/**
 * Detailed sync status modal
 */
interface SyncStatusModalProps {
	visible: boolean;
	onClose: () => void;
}

export function SyncStatusModal({ visible, onClose }: SyncStatusModalProps) {
	const {
		isOnline,
		connectionType,
		status,
		conflicts,
		hasConflicts,
		syncPendingChanges,
		forceSync,
	} = useOfflineVaultContext();

	const [syncing, setSyncing] = useState(false);

	const handleSync = useCallback(async () => {
		if (!isOnline) return;

		setSyncing(true);
		try {
			await syncPendingChanges();
		} catch (error) {
			console.error("Sync failed:", error);
		} finally {
			setSyncing(false);
		}
	}, [isOnline, syncPendingChanges]);

	const handleForceSync = useCallback(async () => {
		if (!isOnline) return;

		setSyncing(true);
		try {
			await forceSync();
		} catch (error) {
			console.error("Force sync failed:", error);
		} finally {
			setSyncing(false);
		}
	}, [isOnline, forceSync]);

	const formatLastSync = (timestamp: number | null) => {
		if (!timestamp) return "Never";

		const now = Date.now();
		const diff = now - timestamp;

		if (diff < 60000) return "Just now";
		if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
		if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`;
		return new Date(timestamp).toLocaleDateString();
	};

	return (
		<Modal
			visible={visible}
			animationType="slide"
			transparent
			onRequestClose={onClose}
		>
			<View className="flex-1 justify-end bg-black/50">
				<View className="rounded-t-3xl bg-background p-6">
					{/* Header */}
					<View className="mb-6 flex-row items-center justify-between">
						<Text className="font-bold text-foreground text-xl">
							Sync Status
						</Text>
						<TouchableOpacity
							onPress={onClose}
							className="rounded-full bg-secondary p-2"
						>
							<X size={20} color="#6b7280" />
						</TouchableOpacity>
					</View>

					{/* Connection Status */}
					<View className="mb-4 rounded-lg bg-secondary p-4">
						<View className="flex-row items-center">
							{isOnline ? (
								<Wifi size={24} color="#22c55e" />
							) : (
								<WifiOff size={24} color="#eab308" />
							)}
							<View className="ml-3">
								<Text className="font-semibold text-foreground">
									{isOnline ? "Connected" : "Offline"}
								</Text>
								<Text className="text-muted-foreground text-sm">
									{connectionType || "Unknown connection type"}
								</Text>
							</View>
						</View>
					</View>

					{/* Sync Info */}
					<View className="mb-4 rounded-lg bg-secondary p-4">
						<View className="mb-3 flex-row items-center justify-between">
							<Text className="text-muted-foreground text-sm">Last Synced</Text>
							<Text className="font-medium text-foreground">
								{formatLastSync(status.lastSyncedAt)}
							</Text>
						</View>

						<View className="mb-3 flex-row items-center justify-between">
							<Text className="text-muted-foreground text-sm">
								Pending Changes
							</Text>
							<View className="flex-row items-center">
								{status.pendingChangesCount > 0 && (
									<View className="mr-2 h-2 w-2 rounded-full bg-blue-500" />
								)}
								<Text className="font-medium text-foreground">
									{status.pendingChangesCount}
								</Text>
							</View>
						</View>

						<View className="flex-row items-center justify-between">
							<Text className="text-muted-foreground text-sm">Conflicts</Text>
							<View className="flex-row items-center">
								{hasConflicts && (
									<View className="mr-2 h-2 w-2 rounded-full bg-red-500" />
								)}
								<Text
									className={`font-medium ${hasConflicts ? "text-red-500" : "text-foreground"}`}
								>
									{status.conflictsCount}
								</Text>
							</View>
						</View>
					</View>

					{/* Conflicts List */}
					{hasConflicts && (
						<View className="mb-4">
							<Text className="mb-2 font-semibold text-foreground">
								Conflicts to Resolve
							</Text>
							{conflicts.slice(0, 3).map((conflict) => (
								<View
									key={conflict.itemId}
									className="mb-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950"
								>
									<View className="flex-row items-center">
										<AlertCircle size={16} color="#ef4444" />
										<Text className="ml-2 font-medium text-red-700 dark:text-red-300">
											Item {conflict.itemId.substring(0, 8)}...
										</Text>
									</View>
									<Text className="mt-1 text-red-600 text-xs dark:text-red-400">
										{conflict.conflictType === "delete_conflict"
											? "Item was deleted on server"
											: "Item was modified on server"}
									</Text>
								</View>
							))}
							{conflicts.length > 3 && (
								<Text className="mt-2 text-center text-muted-foreground text-sm">
									And {conflicts.length - 3} more...
								</Text>
							)}
						</View>
					)}

					{/* Actions */}
					<View className="mt-4 flex-row gap-3">
						{status.pendingChangesCount > 0 && isOnline && (
							<TouchableOpacity
								onPress={handleSync}
								disabled={syncing}
								className={`flex-1 flex-row items-center justify-center rounded-lg py-3 ${
									syncing ? "bg-primary/50" : "bg-primary"
								}`}
							>
								{syncing ? (
									<ActivityIndicator color="#fff" size="small" />
								) : (
									<>
										<Upload size={18} color="#fff" />
										<Text className="ml-2 font-medium text-primary-foreground">
											Sync Now
										</Text>
									</>
								)}
							</TouchableOpacity>
						)}

						<TouchableOpacity
							onPress={handleForceSync}
							disabled={syncing || !isOnline}
							className={`flex-1 flex-row items-center justify-center rounded-lg border py-3 ${
								!isOnline
									? "border-muted bg-muted"
									: "border-primary bg-transparent"
							}`}
						>
							<RefreshCw size={18} color={isOnline ? "#6366f1" : "#9ca3af"} />
							<Text
								className={`ml-2 font-medium ${
									isOnline ? "text-primary" : "text-muted-foreground"
								}`}
							>
								Force Refresh
							</Text>
						</TouchableOpacity>
					</View>

					{/* Offline Notice */}
					{!isOnline && (
						<View className="mt-4 flex-row items-center rounded-lg bg-yellow-100 p-3 dark:bg-yellow-900">
							<CloudOff size={20} color="#ca8a04" />
							<Text className="ml-2 flex-1 text-sm text-yellow-700 dark:text-yellow-300">
								You're offline. Changes will be saved locally and synced when
								you reconnect.
							</Text>
						</View>
					)}

					{/* Bottom padding for safe area */}
					<View className="h-6" />
				</View>
			</View>
		</Modal>
	);
}

/**
 * Floating sync button for screens
 */
export function FloatingSyncButton() {
	const { isOnline, status, syncPendingChanges } = useOfflineVaultContext();
	const [syncing, setSyncing] = useState(false);

	if (status.pendingChangesCount === 0 || !isOnline) {
		return null;
	}

	const handleSync = async () => {
		setSyncing(true);
		try {
			await syncPendingChanges();
		} finally {
			setSyncing(false);
		}
	};

	return (
		<TouchableOpacity
			onPress={handleSync}
			disabled={syncing}
			className="absolute right-4 bottom-24 flex-row items-center rounded-full bg-primary px-4 py-3 shadow-lg"
		>
			{syncing ? (
				<ActivityIndicator color="#fff" size="small" />
			) : (
				<>
					<Cloud size={18} color="#fff" />
					<Text className="ml-2 font-medium text-primary-foreground">
						Sync {status.pendingChangesCount}
					</Text>
				</>
			)}
		</TouchableOpacity>
	);
}

/**
 * Offline mode banner
 */
export function OfflineModeBanner() {
	const { isOnline, status } = useOfflineVaultContext();

	if (isOnline) {
		return null;
	}

	return (
		<View className="flex-row items-center bg-yellow-500 px-4 py-2">
			<WifiOff size={16} color="#fff" />
			<Text className="ml-2 flex-1 font-medium text-sm text-white">
				Offline Mode
			</Text>
			{status.pendingChangesCount > 0 && (
				<View className="rounded-full bg-white/20 px-2 py-0.5">
					<Text className="font-medium text-white text-xs">
						{status.pendingChangesCount} pending
					</Text>
				</View>
			)}
		</View>
	);
}
