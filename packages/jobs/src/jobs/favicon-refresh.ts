import { fetchAndStoreFavicon, listDomainsToRefresh } from "@bittery/favicon";
import { registerJob } from "../registry";
import type { JobDefinition } from "../types";

const STALE_AFTER_DAYS = 30;
const BATCH_SIZE = 200;

const faviconRefreshJob: JobDefinition<void> = {
	options: {
		name: "favicon-refresh",
		description: "Refresh stale or previously-failed cached favicons",
		schedule: { cron: "30 2 * * 0", tz: "UTC" },
		retry: { retryLimit: 1, retryDelay: 300, retryBackoff: true },
		expireInSeconds: 3600,
	},
	handler: async () => {
		const staleBefore = new Date(
			Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
		);
		const domains = await listDomainsToRefresh(BATCH_SIZE, staleBefore);

		let refreshed = 0;
		for (const domain of domains) {
			const result = await fetchAndStoreFavicon(domain);
			if (result) {
				refreshed += 1;
			}
		}

		if (domains.length > 0) {
			console.log(
				`[jobs:favicon-refresh] processed ${domains.length} domains, refreshed ${refreshed}`,
			);
		}
	},
};

registerJob(faviconRefreshJob);

export default faviconRefreshJob;
