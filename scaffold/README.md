<p align="center">
  <img src="https://raw.githubusercontent.com/homebridge/branding/master/logos/homebridge-wordmark-logo-vertical.png" width="150">
</p>

# homebridge-teufel-raumfeld

**Raumfeld, in Apple Home.**

A [Homebridge](https://homebridge.io) plugin that exposes your Teufel Raumfeld
multiroom speakers to Apple HomeKit — every room as a tile, every Raumfeld group
as a single controllable accessory, with optional AirPlay streaming from any
iPhone.

```sh
npm install -g homebridge-teufel-raumfeld
```

![npm](https://img.shields.io/npm/v/homebridge-teufel-raumfeld) ![license](https://img.shields.io/badge/license-MIT-blue) ![homebridge](https://img.shields.io/badge/homebridge-%3E%3D1.8-blueviolet)

## Features

- **Auto-discovery** — finds the Raumfeld host on your network (SSDP), or point it at a fixed IP.
- **Native Home tiles** — each room appears as a HomeKit speaker with volume, mute and play/pause.
- **Multiroom groups** — groups you make in the Raumfeld app show up as one accessory; member rooms are controlled together (see below).
- **Per-zone volume** — HomeKit volume maps to Raumfeld volume; group volume can be kept in sync.
- **AirPlay 2 streaming** *(optional)* — advertise zones as AirPlay receivers to stream straight from iOS.
- **Siri** — “Hey Siri, set the Kitchen to 30%.”
- **Cross-subnet friendly** — resolves speakers via the host’s HTTP API, so Homebridge and the speakers can live on different VLANs.

## Configuration

Configure from the Homebridge Config UI X screen (a custom settings page ships
with the plugin), or add a platform block to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "Raumfeld",
      "name": "Raumfeld",
      "autoDiscover": true,
      "host": "192.168.1.50",
      "pollInterval": 5,
      "airplay":   { "enabled": true, "bufferMs": 220 },
      "multiroom": { "exposeGroups": true, "syncGroupVolume": true }
    }
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `autoDiscover` | `true` | Find the Raumfeld host via SSDP. Turn off to use `host`. |
| `host` | — | IP/hostname of the Raumfeld host. Required when `autoDiscover` is off, or when Homebridge and the speakers are on different subnets (SSDP can’t cross subnets). |
| `pollInterval` | `2` | Safety-net poll seconds; live changes arrive instantly via the host long-poll. |
| `airplay.enabled` | `true` | Advertise zones as AirPlay receivers. |
| `airplay.bufferMs` | `220` | AirPlay audio buffer. |
| `multiroom.exposeGroups` | `true` | Expose active Raumfeld groups as accessories. |
| `multiroom.syncGroupVolume` | `true` | Apply group volume changes to all members. |

Restart Homebridge after saving.

## Multiroom behaviour

Groups are **authored in the Raumfeld app**, not in Homebridge — the plugin
mirrors them live. When rooms are combined into a Raumfeld group:

- the group is exposed as **one** accessory (the controllable unit);
- each member room stays visible but its writes are **routed to the group lead**, so controlling it controls the group;
- dissolve the group in the Raumfeld app and the rooms become individually controllable again.

## Tested with

Stereo L · Stereo M · One · One M · Stream · Soundbar · Connector

## Requirements

- Node.js ≥ 18
- Homebridge ≥ 1.8 (Homebridge 2.0 ready)
- A Raumfeld host (any Raumfeld/Teufel speaker or Connector acting as host) reachable on port `47365`

## Development

The plugin sources live in this directory.

```sh
npm install
npm run build       # rimraf ./dist && tsc
npm run lint
npm run dev         # nodemon: rebuild + relaunch Homebridge against test/hbConfig
```

Architecture: a dynamic platform (`src/platform.ts`) mirrors the host’s rooms and
zones as accessories; `src/raumfeldClient.ts` talks to the host HTTP API
(`/getZones`, `/listDevices`, long-poll `updateId`) and drives each renderer over
SOAP (RenderingControl / AVTransport); `src/zoneAccessory.ts` is the per-accessory
HomeKit service; `src/airplayBridge.ts` manages the AirPlay receiver lifecycle.

## License

MIT © Alexander Peither
