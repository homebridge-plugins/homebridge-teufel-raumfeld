# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
