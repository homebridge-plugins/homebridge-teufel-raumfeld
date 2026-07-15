# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-07-15

### Fixed
- Bound HTTP body reads with a per-read timeout and always release the header
  timer / cancel undrained bodies, so a slow or dead host can't hang the plugin
  or leak sockets.
- Long-poll now reports success and drains its body; the loop backs off on
  failure instead of tight-retrying an unreachable host.
- Control writes throw on an unresolved UPnP endpoint instead of silently
  succeeding; group volume/mute fan out to all members and aggregate failures.
- Play state is populated from AVTransport (rooms no longer always report paused).
- `/getZones` payloads without a `<zoneConfig>` root are rejected, so a bad
  response no longer prunes every accessory.
- Control URLs resolve against `<URLBase>` / the description path; SOAP scalar
  parsing tolerates namespace-prefixed, attributed tags.
- Cached renderer endpoints invalidate when a device's location changes.
- Accessory updates only push characteristics the host reported (no clobbering
  cached volume/mute/state on a failed refresh).
- Bootstrap aborts if Homebridge shuts down mid discover/connect; sync passes are
  serialised so a stale snapshot can't overwrite a newer one.
- AirPlay sessions are no longer marked active without a real receiver; the
  bridge warns once that the feature is unavailable in this build.

## [0.1.0] - 2026-07-05

### Added
- Initial release: dynamic platform exposing Raumfeld rooms and zones to HomeKit.
- Room accessories (SmartSpeaker) with volume, mute and play/pause.
- Live mirroring of Raumfeld groups as single accessories; member writes routed to the group lead.
- Raumfeld host client: SSDP host discovery, `/getZones` parsing, `/listDevices`
  renderer resolution (works across subnets), SOAP RenderingControl/AVTransport
  control, and a long-poll on `updateId` for instant group changes.
- AirPlay bridge lifecycle scaffold (per-zone receiver management).
- Custom Homebridge Config UI X settings screen.
