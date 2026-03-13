export interface CachedFavicon {
	data: Buffer;
	contentType: string;
}

interface CacheEntry extends CachedFavicon {
	size: number;
}

export interface FaviconLruCacheOptions {
	maxEntries?: number;
	maxEntryBytes?: number;
	maxTotalBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_ENTRY_BYTES = 100 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export class FaviconLruCache {
	private readonly maxEntries: number;
	private readonly maxEntryBytes: number;
	private readonly maxTotalBytes: number;
	private readonly entries = new Map<string, CacheEntry>();
	private totalBytes = 0;

	constructor(options: FaviconLruCacheOptions = {}) {
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
		this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	}

	get(domain: string): CachedFavicon | undefined {
		const existing = this.entries.get(domain);
		if (!existing) {
			return undefined;
		}

		this.entries.delete(domain);
		this.entries.set(domain, existing);

		return {
			data: Buffer.from(existing.data),
			contentType: existing.contentType,
		};
	}

	set(domain: string, data: Buffer, contentType: string): void {
		const payload = Buffer.from(data);
		const size = payload.byteLength;

		if (size > this.maxEntryBytes) {
			return;
		}

		const existing = this.entries.get(domain);
		if (existing) {
			this.totalBytes -= existing.size;
			this.entries.delete(domain);
		}

		this.entries.set(domain, {
			data: payload,
			contentType,
			size,
		});
		this.totalBytes += size;

		this.evictIfNeeded();
	}

	private evictIfNeeded(): void {
		while (
			this.entries.size > this.maxEntries ||
			this.totalBytes > this.maxTotalBytes
		) {
			const oldestKey = this.entries.keys().next().value;
			if (!oldestKey) {
				break;
			}
			const oldest = this.entries.get(oldestKey);
			this.entries.delete(oldestKey);
			if (oldest) {
				this.totalBytes -= oldest.size;
			}
		}
	}
}
