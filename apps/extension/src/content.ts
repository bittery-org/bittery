/**
 * Content Script entrypoint
 */

import { initContentScript } from "./content-script/init";
import { initPasskeyBridge } from "./content-script/passkey-bridge";

initPasskeyBridge();
initContentScript();
