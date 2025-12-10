import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		// Check if user has stored credentials
		const hasSecretKey = await tauriStorage.hasStoredSecretKey();
		const sessionValid = await tauriStorage.isSessionValid();

		if (hasSecretKey && sessionValid) {
			// Try to restore session
			const restored = await tauriStorage.tryRestoreSession();
			if (restored) {
				throw redirect({ to: "/vault" });
			}
			throw redirect({ to: "/unlock" });
		}

		throw redirect({ to: "/login" });
	},
});
