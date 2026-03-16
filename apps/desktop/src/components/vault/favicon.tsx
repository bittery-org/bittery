import type { VaultFaviconProps } from "@bittery/ui";
import { VaultFavicon } from "@bittery/ui";
import { readCurrentAuthServerUrl } from "@/lib/auth-server";

type FaviconProps = Omit<VaultFaviconProps, "defaultServerUrl">;

export function Favicon(props: FaviconProps) {
	return <VaultFavicon {...props} defaultServerUrl={readCurrentAuthServerUrl()} />;
}
