import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import {
	applyResolvedTheme,
	getSystemTheme,
	type ResolvedTheme,
	readStoredThemePreference,
	type ThemePreference,
	writeStoredThemePreference,
} from "../lib/theme";

interface DesktopThemeStatus {
	available: boolean;
	theme?: ThemePreference | null;
}

interface ThemeContextValue {
	/** The extension's own stored preference. */
	theme: ThemePreference;
	/** The concrete theme currently applied to the document. */
	resolvedTheme: ResolvedTheme;
	/** Update (and persist) the extension's own preference. */
	setTheme: (preference: ThemePreference) => void;
	/**
	 * True when the desktop app is available and therefore dictates the theme.
	 * The local segmented control is disabled in this state.
	 */
	isDesktopManaged: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const SYSTEM_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function subscribeToSystemTheme(onChange: () => void): () => void {
	const media = globalThis.matchMedia?.(SYSTEM_MEDIA_QUERY);
	if (!media) return () => {};
	media.addEventListener("change", onChange);
	return () => media.removeEventListener("change", onChange);
}

/** Reactively track the OS color scheme without a manual effect. */
function useSystemTheme(): ResolvedTheme {
	return useSyncExternalStore(
		subscribeToSystemTheme,
		getSystemTheme,
		() => "light" as ResolvedTheme,
	);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const queryClient = useQueryClient();
	const [preference, setPreference] = useState<ThemePreference>(
		readStoredThemePreference,
	);
	const systemTheme = useSystemTheme();

	// Desktop status carries the desktop app's appearance setting. When the
	// desktop app is running it overrides the extension's local preference.
	const desktopStatusQuery = useQuery<DesktopThemeStatus | null>({
		queryKey: ["desktopStatus"],
		queryFn: async () => {
			return await new Promise<DesktopThemeStatus | null>((resolve) => {
				try {
					chrome.runtime.sendMessage(
						{ type: "CHECK_DESKTOP_STATUS" },
						(response: DesktopThemeStatus | undefined) => {
							resolve(response?.available ? response : null);
						},
					);
				} catch {
					resolve(null);
				}
			});
		},
		refetchInterval: 5000,
		staleTime: 2000,
	});

	// The background worker forwards the desktop `theme_changed` event as a
	// runtime message; refetch desktop status so the override applies instantly.
	useEffect(() => {
		const handleMessage = (message: { type?: string }) => {
			if (
				message.type === "THEME_CHANGED" ||
				message.type === "DESKTOP_LOCKED" ||
				message.type === "DESKTOP_UNLOCKED"
			) {
				void queryClient.invalidateQueries({ queryKey: ["desktopStatus"] });
			}
		};
		chrome.runtime.onMessage.addListener(handleMessage);
		return () => chrome.runtime.onMessage.removeListener(handleMessage);
	}, [queryClient]);

	const desktopStatus = desktopStatusQuery.data ?? null;
	const isDesktopManaged = desktopStatus?.available === true;

	const resolvedTheme = useMemo<ResolvedTheme>(() => {
		if (isDesktopManaged && desktopStatus?.theme) {
			return desktopStatus.theme === "system"
				? systemTheme
				: desktopStatus.theme;
		}
		return preference === "system" ? systemTheme : preference;
	}, [isDesktopManaged, desktopStatus?.theme, preference, systemTheme]);

	// Apply the resolved theme to the document root. This is a genuine sync to
	// an external system (the DOM + the no-flash cache) and must run on change.
	useEffect(() => {
		applyResolvedTheme(resolvedTheme);
	}, [resolvedTheme]);

	const setTheme = useCallback((next: ThemePreference) => {
		setPreference(next);
		writeStoredThemePreference(next);
	}, []);

	const value = useMemo<ThemeContextValue>(
		() => ({
			theme: preference,
			resolvedTheme,
			setTheme,
			isDesktopManaged,
		}),
		[preference, resolvedTheme, setTheme, isDesktopManaged],
	);

	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
}

export function useTheme(): ThemeContextValue {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return context;
}
