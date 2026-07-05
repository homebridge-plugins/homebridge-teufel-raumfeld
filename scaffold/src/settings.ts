/** Must match pluginAlias in config.schema.json and the platform name in config.json. */
export const PLATFORM_NAME = 'Raumfeld';

/** Must match the "name" field in package.json. */
export const PLUGIN_NAME = 'homebridge-raumfeld';

/** Raumfeld host HTTP API port (zone read/mutate: /getZones, /connectRoomToZone, /dropRoom). */
export const RAUMFELD_HTTP_PORT = 47365;
