# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-07-16

### Fixed
- Tapping a zone's on/off tile no longer throws "Unhandled error thrown inside
  write handler". Playback control (Play) on a zone with nothing queued faults
  with UPnP 701 (transition not available); this is now treated as a no-op and
  the tile reverts, instead of crashing the write handler. All other SOAP write
  failures are surfaced as a clean HomeKit status so Home reverts the control
  rather than logging a stack trace. Note: on/off can only resume an existing
  source — starting audio still requires AirPlay or the Raumfeld app.

## [0.3.0] - 2026-07-16

### Added
- Cross-subnet host discovery. SSDP multicast is link-local and can't reach
  speakers on a different subnet/VLAN than Homebridge. A new optional
  `discoverySubnet` (CIDR, e.g. `192.168.20.0/24`, prefix /22–/30) makes
  auto-discover fall back to a bounded unicast scan of that range when SSDP
  finds nothing — both at runtime and in the config UI's live device list.

### Changed
- Zone accessories are now modeled as a Fan (On = play/pause, RotationSpeed =
  volume) instead of a SmartSpeaker. The Apple Home app does not render a
  third-party SmartSpeaker (it shows "Not Supported"), so this gives a working
  on/off + volume tile in Home. Accessories cached from an earlier build have
  their stale SmartSpeaker service removed automatically on load.

### Fixed
- The custom config UI no longer erases advanced AirPlay settings
  (`binaryPath`, `streamHost`, `streamPort`) when saving; the edited
  `enabled`/`bufferMs` fields are merged into the existing object instead.

## [0.2.0] - 2026-07-16

### Added
- AirPlay streaming is now functional. Each zone is advertised as an AirPlay
  receiver via a per-zone `shairport-sync` process; the decoded audio is
  re-served over HTTP and the zone's Raumfeld renderer is pointed at it
  (SetAVTransportURI + Play). Grouped zones play through the lead renderer so
  Raumfeld keeps members in sync. Requires `shairport-sync` on the Homebridge
  host; if absent, AirPlay stays off with a one-time warning. New config:
  `airplay.binaryPath`, `airplay.streamHost`, `airplay.streamPort`.

## [0.1.2] - 2026-07-15

### Fixed
- Sanitize room and zone names before they reach HomeKit so HAP-NodeJS no longer
  rejects them. Zone names were joined with `+` (e.g. `Bad + Küche`), an
  unsupported character that triggered an "invalid 'Name' characteristic" warning
  and could stop the accessory being added in the Home app. `&`/`+` are now
  spelled out as "and", unsupported symbols/emoji are dropped, and the name is
  trimmed to start and end with a letter or number (Unicode letters like umlauts
  are preserved).

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
