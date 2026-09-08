export function recoverySpoolDirectory() {
	const files = new Map<string, Uint8Array>();
	let closed = 0;
	let failWrite = false;
	const stored = (name: string) => {
		const value = files.get(name);
		if (value === undefined) throw new DOMException("missing", "NotFoundError");
		return value;
	};
	const handle = {
		async getFileHandle(name: string, options?: { create?: boolean }) {
			if (!files.has(name)) {
				if (!options?.create)
					throw new DOMException("missing", "NotFoundError");
				files.set(name, new Uint8Array());
			}
			return {
				async createSyncAccessHandle() {
					return {
						write(bytes: Uint8Array, options: { at: number }) {
							if (failWrite)
								throw new DOMException("full", "QuotaExceededError");
							const count = Math.min(bytes.length, 3);
							const prior = stored(name);
							const next = new Uint8Array(
								Math.max(prior.length, options.at + count),
							);
							next.set(prior);
							next.set(bytes.subarray(0, count), options.at);
							files.set(name, next);
							return count;
						},
						truncate(size: number) {
							files.set(name, stored(name).slice(0, size));
						},
						flush() {},
						close() {
							closed++;
						},
					};
				},
				async getFile() {
					return new File([stored(name)], name);
				},
			};
		},
		async *entries(): AsyncIterableIterator<[string, { kind: string }]> {
			for (const name of files.keys()) yield [name, { kind: "file" }];
		},
		async removeEntry(name: string) {
			if (!files.delete(name))
				throw new DOMException("missing", "NotFoundError");
		},
	};
	return {
		handle,
		files,
		closed: () => closed,
		fail: () => {
			failWrite = true;
		},
	};
}
