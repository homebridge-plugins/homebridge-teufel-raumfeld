# Scaffold

Starter files for `homebridge-raumfeld`, referenced by the parent `README.md` build brief. These are a **skeleton with typed stubs**, not a finished plugin — search for `TODO` to see what to implement.

## Move into the repo root
```
package.json
config.schema.json      # drives the Homebridge Config UI X settings screen (design 1b)
tsconfig.json
src/
  index.ts              # entry point, registers the platform
  settings.ts           # constants (platform name, host port)
  platform.ts           # dynamic platform: discover, sync rooms/zones, multiroom lock rule
  zoneAccessory.ts      # per-accessory HomeKit service (SmartSpeaker + volume + lock state)
  raumfeldClient.ts     # STUB: host HTTP API (:47365) + UPnP/OpenHome SOAP
```

## Build
```
npm install
npm run build          # tsc -> dist/
```
Then add to Homebridge `config.json` a platform block `{ "platform": "Raumfeld" }` (or configure via the UI from `config.schema.json`).

## What's left to implement (the real work)
1. **`raumfeldClient.ts`** — SSDP discovery, `GET /getZones` parsing, SOAP volume/play/mute, and the group endpoints. Prefer the long-poll `updateId` / GENA eventing so groups made in the Raumfeld app appear instantly.
2. **`platform.ts` `sync()`** — the reconcile diff and accessory pruning.
3. **AirPlay bridge** — a shairport-sync / airtunes2 receiver per zone that pushes PCM into the zone renderer (`SetChannel`/play-URL). AirPlay 1 single-zone is a fine first milestone.
4. **Multiroom lock** — confirm the HomeKit treatment for "in use" members (StatusFault vs. routing writes to the group lead) behaves well in the Home app; see the parent README.

The visual target for the config screen and the end-user Home experience is `../Raumfeld Homebridge.dc.html` (badges 1b and 1a).
