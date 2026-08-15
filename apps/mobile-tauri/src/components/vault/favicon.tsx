import type { VaultFaviconProps } from "@bittery/ui";
import { VaultFavicon } from "@bittery/ui";
import { readCurrentAuthServerUrl } from "@/lib/auth-server";

/**
 * Mirrors desktop's `apps/desktop/src/components/vault/favicon.tsx` — same wrapper, duplicated
 * because apps cannot import from one another. Supplies the active server as the fallback base
 * for relative avatar/favicon URLs.
 */
type FaviconProps = Omit<VaultFaviconProps, "defaultServerUrl">;

export function Favicon(props: FaviconProps) {
	return (
		<VaultFavicon {...props} defaultServerUrl={readCurrentAuthServerUrl()} />
	);
}
