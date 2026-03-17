import { bitteryBttrxImportProvider } from "./providers/bittery-bttrx";
import { onePassword1puxImportProvider } from "./providers/1password-1pux";
import type { ImportProvider, ImportProviderId } from "./types";

const providers: ImportProvider[] = [
	onePassword1puxImportProvider,
	bitteryBttrxImportProvider,
];

export function getImportProviders(): ImportProvider[] {
	return providers;
}

export function getImportProvider(
	providerId: ImportProviderId,
): ImportProvider | null {
	return providers.find((provider) => provider.id === providerId) ?? null;
}

export function getImportProviderForFile(file: File): ImportProvider | null {
	return providers.find((provider) => provider.canParse(file)) ?? null;
}
