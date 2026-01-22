import { Redirect } from "expo-router";

/**
 * Redirect from old vault list route to new tabs-based vaults screen.
 * This maintains backwards compatibility with any existing links.
 */
export default function VaultIndexRedirect() {
	return <Redirect href="/(tabs)/vaults" />;
}
