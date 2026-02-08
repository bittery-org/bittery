export interface JobRetryConfig {
	retryLimit?: number;
	retryDelay?: number;
	retryBackoff?: boolean;
}

export interface JobSchedule {
	cron: string;
	tz?: string;
}

export interface JobDefinition<TData = unknown> {
	options: {
		name: string;
		description: string;
		schedule?: JobSchedule;
		retry?: JobRetryConfig;
		expireInSeconds?: number;
	};
	handler: (data: TData) => Promise<void>;
}
