import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

const DISMISSED_PREFIX = "onboarding.import.dismissed.";
const COMPLETED_PREFIX = "onboarding.import.completed.";

function getScopedKey(prefix: string, userId: string): string {
	return `${prefix}${userId}`;
}

function readLocalFlag(key: string): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	return window.localStorage.getItem(key) === "1";
}

function writeLocalFlag(key: string, value: boolean): void {
	if (typeof window === "undefined") {
		return;
	}
	if (value) {
		window.localStorage.setItem(key, "1");
		return;
	}
	window.localStorage.removeItem(key);
}

export function useImportOnboardingState() {
	const api = useApiClient();
	const userQuery = useQuery(apiQueries.auth.me(api));
	const userId = userQuery.data?.id ?? null;

	const [isDismissed, setIsDismissed] = useState(false);
	const [isCompleted, setIsCompleted] = useState(false);

	const dismissedKey = useMemo(
		() => (userId ? getScopedKey(DISMISSED_PREFIX, userId) : null),
		[userId],
	);
	const completedKey = useMemo(
		() => (userId ? getScopedKey(COMPLETED_PREFIX, userId) : null),
		[userId],
	);

	useEffect(() => {
		if (!dismissedKey || !completedKey) {
			setIsDismissed(false);
			setIsCompleted(false);
			return;
		}
		setIsDismissed(readLocalFlag(dismissedKey));
		setIsCompleted(readLocalFlag(completedKey));
	}, [dismissedKey, completedKey]);

	const markDismissed = useCallback(() => {
		if (!dismissedKey) {
			return;
		}
		writeLocalFlag(dismissedKey, true);
		setIsDismissed(true);
	}, [dismissedKey]);

	const markCompleted = useCallback(() => {
		if (!completedKey) {
			return;
		}
		writeLocalFlag(completedKey, true);
		setIsCompleted(true);
	}, [completedKey]);

	const clearDismissed = useCallback(() => {
		if (!dismissedKey) {
			return;
		}
		writeLocalFlag(dismissedKey, false);
		setIsDismissed(false);
	}, [dismissedKey]);

	return {
		userId,
		isReady: !!userId,
		isDismissed,
		isCompleted,
		showCard: !!userId && !isDismissed && !isCompleted,
		markDismissed,
		markCompleted,
		clearDismissed,
	};
}
