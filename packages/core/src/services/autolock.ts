export interface IAutolockService {
	initialize(): Promise<void>;
	recordActivity(): void;
	shouldLock(): Promise<boolean>;
	lock(): Promise<void>;
	onLock(callback: () => void): () => void;
	getTimeout(): Promise<number>;
	setTimeout(ms: number): Promise<void>;
	dispose(): void;
}
