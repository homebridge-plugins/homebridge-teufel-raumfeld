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

## Implementation status
1. **`raumfeldClient.ts`** — ✅ SSDP discovery, `GET /getZones` XML parsing, hand-rolled SOAP for `RenderingControl` (volume/mute) and `AVTransport` (play/pause/stop), the `connectRoomToZone` / `dropRoom` group endpoints, and a `waitForChange()` long-poll on `updateId` so groups made in the Raumfeld app appear near-instantly. Renderer control URLs are resolved lazily from each device description (LOCATION learned via SSDP).
2. **`platform.ts` `sync()`** — ✅ single-round-trip reconcile of rooms + zones, add/update/prune of accessories, member-lock computation, and a long-poll loop with an infrequent safety-net poll.
3. **`zoneAccessory.ts`** — ✅ SmartSpeaker with volume/mute/transport; locked members are flagged via `StatusFault` and their writes are routed to the group lead renderer (README "Multiroom" rule).
4. **`airplayBridge.ts`** — ⏳ lifecycle scaffold: advertises one receiver per zone/group and owns session bookkeeping. The native audio path (shairport-sync / airtunes2 spawn + PCM → renderer hand-off) is left as a single documented seam, `startReceiver()`. AirPlay 1 single-zone is the intended first milestone.
5. **Config UI (`homebridge-ui/`)** — ✅ a custom Config UI X page recreating design **1b** (status pill, connection, live device toggles, AirPlay/multiroom sections, read-only live zone groups) backed by `server.js`, which reads `/getZones` from the host.

> **Build note:** this was authored without a local Node toolchain, so `npm run build` / `tsc` were not executed here — run them before publishing.

The visual target for the config screen and the end-user Home experience is `../Raumfeld Homebridge.dc.html` (badges 1b and 1a).
