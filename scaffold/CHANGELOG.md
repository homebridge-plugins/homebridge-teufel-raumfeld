# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-08-25

### Fixed
- Follow the host's session redirect again. 0.4.0 refused every 3xx as an
  anti-SSRF measure, on the assumption that nothing in the Raumfeld surface
  redirects. It does: the host answers *every* `/getZones` and `/listDevices`
  with a 307 to a per-session UUID path (`/<uuid>/getZones`), so 0.4.0 could not
  talk to a real host at all — bootstrap failed with
  `TypeError: fetch failed … unexpected redirect`. Redirects are now followed by
  hand, capped at 5 hops. A hop to a different origin must still pass the
  private-address guard, so the SSRF protection stands; a same-origin hop is
  always allowed, which also keeps a host configured by name working. The
  custom UI's discovery and status pill had the same defect and the same fix.

## [0.4.0] - 2026-08-25

### Security
- Fix a remote crash in the AirPlay stream server. A malformed request-target
  such as `GET //[` threw `TypeError: Invalid URL` straight out of the request
  callback, which Node surfaces as an uncaught exception — taking the whole
  Homebridge process down. The endpoint is bound to every interface and this
  needed no token, so any device on the network could stop the bridge with one
  request. Malformed targets now return 400, and the handler is wrapped so no
  future throw can escape it.
- Cap every response body read from the network at 8 MiB. The existing timeouts
  bound stalled transfers but not a body that keeps arriving quickly, so a
  hostile or malfunctioning host could stream unbounded data into memory via
  `/getZones`, `/listDevices`, or a device description.
- Add `airplay.password`. Without it every zone is advertised as an **open**
  AirPlay receiver, so any device on the network can play audio through the
  speakers. The plugin now warns once at startup when no password is set. The
  value is passed to `shairport-sync` on its command line and is therefore
  visible to other local users of the Homebridge host.
- Restrict every URL learned from the network — device `location`s from
  `/listDevices`, `<URLBase>`, and each service `controlURL` — to plain HTTP(S)
  on a private address, and stop following redirects. A spoofed or compromised
  Raumfeld host could previously name any URL and have the plugin fetch it or
  POST SOAP to it, including the Homebridge admin API on loopback and cloud
  metadata endpoints.
- Confine discovery sweeps to private address space (10/8, 172.16/12,
  192.168/16, 100.64/10). The custom UI's `/discover` endpoint accepted any
  CIDR, which turned it into a 1022-host concurrent scanner aimable at the
  public internet.
- Rotate each zone's AirPlay stream token per session instead of once per
  process. Renderers echo `CurrentURI` back to unauthenticated callers on the
  LAN, so a leaked token previously stayed valid for the plugin's lifetime.
- Protect each live AirPlay PCM URL with a random per-zone token, reject
  malformed paths without throwing, refuse requests when no source is active,
  and cap overlapping renderer connections per zone.

### Changed
- Replace `node-ssdp` with a ~100-line built-in M-SEARCH client
  (`src/ssdpClient.ts`). `node-ssdp` is unmaintained and pulled in `ip`
  (GHSA-2p57-rm9w-gvfp, high); npm's suggested remedy for that advisory is a
  downgrade to `node-ssdp` 1.0.0. Multi-interface behaviour is unchanged.
- Upgrade `fast-xml-parser` to 5.x (GHSA-gh4j-gqv2-49f6). The plugin only ever
  used `XMLParser`, never the affected `XMLBuilder`. The published package now
  reports no known vulnerabilities.

### Fixed
- Enable the bundled custom Homebridge UI with `customUi: true` and bound its
  response-body reads with the same deadline as the header request.
- Retry the AirPlay stream server after a failed bind and restart an unexpected
  `shairport-sync` exit while its target still exists.
- Make the documented safety-net poll interval match its actual 30–60 second
  range. Remove the unused `airplay.bufferMs` setting and inaccurate AirPlay 2
  labels; each advertised zone intentionally uses an AirPlay 1 receiver.

## [0.3.3] - 2026-08-03

### Fixed
- Auto-discovery now finds the host on machines with more than one network
  interface (Wi-Fi + Ethernet, VLAN NICs, an active VPN tunnel). SSDP was sent
  from a single default-bound socket, which the OS routes out whichever
  interface owns the multicast route — so an M-SEARCH never reached speakers on
  any other interface's subnet and discovery reported "No Raumfeld host found".
  The search now runs one SSDP client per local IPv4 interface, bound
  explicitly, and merges the responses.
- When SSDP finds nothing and no `discoverySubnet` is configured, auto-discovery
  now unicast-sweeps every local IPv4 subnet instead of giving up. Previously
  the sweep only ran if `discoverySubnet` was set by hand, so the common
  multi-homed case fell through both discovery paths. Subnets are normalised to
  their network address, de-duplicated across NICs, capped, and blocks wider
  than /22 plus 169.254 link-local addresses are skipped.

### Changed
- `discoverySubnet` is now documented as a rare escape hatch — needed only when
  the speakers sit on a subnet Homebridge has no interface on, since local
  subnets are scanned automatically.

## [0.3.2] - 2026-07-16

### Fixed
- The on/off tile no longer stays lit for up to 30 seconds after tapping a zone
  with nothing queued. 0.3.1 swallowed the UPnP 701 fault and reported the write
  as successful, so Home kept showing "on" until the next sync pass (the long-poll
  never fires for a no-op, leaving the 30 s safety-net interval to correct it).
  The tile now snaps back to off right away, without an error: the Home app can't
  render a custom message, so the explanation ("nothing is queued — start audio
  from AirPlay or the Raumfeld app first") goes to the Homebridge log instead.
  Other SOAP write failures still surface as a HomeKit communication error.

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
