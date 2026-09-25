import type {
	MaterialPublication,
	MaterialPublicationSource,
} from "@bittery/core/services/material-publication";
import { nativeMessagingClient } from "./native-messaging-client";

/** One captured delivery lifetime for local Account material. This makes no
 * Desktop request; ordinary Extension-only unlock remains local. */
export const localMaterialPublication: MaterialPublicationSource = {
	async capture(): Promise<MaterialPublication> {
		const generation = await nativeMessagingClient.captureDeliveryGeneration();
		return {
			check: () => nativeMessagingClient.assertCurrentDelivery(generation),
			isCurrent: () => nativeMessagingClient.isCurrentDelivery(generation),
			captureCleanup: (accountId) =>
				nativeMessagingClient.captureMaterialFailureCleanup(
					generation,
					accountId,
				),
			run: (accountId, publish, installed) =>
				nativeMessagingClient.withLocalMaterialMutation(
					generation,
					accountId,
					publish,
					installed,
				),
		};
	},
};
