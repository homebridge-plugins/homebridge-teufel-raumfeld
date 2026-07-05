import type { API } from 'homebridge';
import { PLATFORM_NAME } from './settings.js';
import { RaumfeldPlatform } from './platform.js';

/**
 * Homebridge entry point. Registers the dynamic platform.
 */
export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, RaumfeldPlatform);
};
