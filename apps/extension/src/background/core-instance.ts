import { createCoreContext } from "@bittery/core";
import { cryptoAdapter } from "../lib/crypto-adapter";
import { itemCache, storage } from "../lib/storage";

export const core = createCoreContext({
	storage,
	itemCache,
	crypto: cryptoAdapter,
});
