/**
 * What a place that kept Account material is called on screen.
 *
 * Three gestures report the same areas now — "Log out", "Use a different account" and the
 * Danger Zone deletion — so the wording lives once. A user reads "Your items and vaults",
 * never `platformStorage`: a phase name tells them nothing they can act on, and the phase
 * vocabulary belongs to the Runtime, not to a screen.
 */

import type { AccountRemovalArea } from "@/lib/account-removal";
import type { useI18n } from "@/providers/i18n-provider";

type Messages = ReturnType<typeof useI18n>["m"];

export function getTeardownAreaLabel(
	area: AccountRemovalArea,
	m: Messages,
): string {
	switch (area) {
		case "replica":
			return m.teardown_area_replica();
		case "platformStorage":
			return m.teardown_area_platform_storage();
		case "attachmentArtifacts":
			return m.teardown_area_attachment_artifacts();
		case "hostCleanup":
			return m.teardown_area_host_cleanup();
		case "runtimeSession":
			return m.teardown_area_runtime_session();
		case "serverAccount":
			return m.teardown_area_server_account();
		case "transitionalStore":
			return m.teardown_area_transitional_store();
	}
}
