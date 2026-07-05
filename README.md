# Handoff: homebridge-raumfeld

A Homebridge plugin that exposes Teufel Raumfeld multiroom speakers to Apple HomeKit and lets any iPhone AirPlay directly to a zone.

## Overview
This bundle documents the design for a Homebridge dynamic-platform plugin (`homebridge-raumfeld`). It covers four surfaces:
1. **Device control** — how the speakers/zones appear and behave inside the Apple Home app (rooms grid, Now Playing, and an in-app AirPlay output picker).
2. **Plugin config** — the settings screen the user sees in Homebridge Config UI X to pair and manage devices.
3. **Architecture** — how the plugin bridges HomeKit ⇄ Homebridge ⇄ Raumfeld, including the AirPlay path.
4. **Landing / README page** — install and feature summary.

The Home-app screens (1 and 4 of the diagram) illustrate the *end-user experience produced by the plugin*, not screens you build — Apple's Home app renders those from the HomeKit accessories your plugin publishes. The screens you actually implement are the **config UI** and the **plugin runtime**.

## About the Design Files
`Raumfeld Homebridge.dc.html` is a **design reference created in HTML** — a prototype showing intended look and behavior, not production code to copy directly. It is a single self-contained canvas holding all four surfaces side by side (badges `1a`–`1d`).

The task is **not** to ship this HTML. It is to build a real Homebridge plugin (Node.js / TypeScript) whose:
- **HomeKit accessories** produce the experience shown in `1a`,
- **Config UI** (a custom Homebridge Config UI X `homebridge-ui` page, or a `config.schema.json`) recreates `1b`,
- **runtime** implements the data flow in `1c`.

Recreate the config UI in whatever the plugin's chosen UI stack is (plain HTML/JS custom UI is standard for Homebridge). Use Homebridge's established plugin patterns (`hap-nodejs`, dynamic platform, accessory cache).

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, and states are specified. The config UI (`1b`) should be recreated closely; the Home-app screens (`1a`) are reference for *behavior* since Apple owns that rendering.

## Target platform & stack
- **Runtime:** Node.js ≥ 18, Homebridge ≥ 1.8, `hap-nodejs`.
- **Language:** TypeScript recommended.
- **Plugin type:** Dynamic platform (`api.registerPlatform`), accessories restored from cache + discovery.
- **Raumfeld integration:** Raumfeld host exposes UPnP/OpenHome (SSDP discovery + SOAP control + GENA eventing). Libraries such as `node-ssdp`, `upnp-device-client`, or a hand-rolled OpenHome client. The Raumfeld host runs an HTTP API on port 47365 (`/getZones`, `/connectRoomToZone`, `/dropRoom`) that is the simplest way to read and mutate zone/group state.
- **AirPlay receiver:** to expose zones as AirPlay 2 targets, embed/spawn a shairport-sync-style receiver per zone (e.g. `airtunes2`/`nqptp`+`shairport-sync`, or `node_airtunes2`), decode to PCM, and push the stream into the Raumfeld zone renderer via its OpenHome `SetChannel`/play-URL. AirPlay 2 multi-room sync is non-trivial; AirPlay 1 single-zone is a valid first milestone.

## Screens / Views

### 1a — Device control (Apple Home app) — 3 phone screens
Reference only; produced by the accessories your plugin publishes.

**Screen A — "Speakers" rooms grid**
- **Purpose:** see and control each Raumfeld zone as a HomeKit accessory.
- **Layout:** iOS grouped list. Title "Speakers" (34px/700). A full-width **active group** card on top, then a 2-column tile grid (12px gap, tiles 132px tall, 18px radius), then a footnote.
- **Active group card:** green tint `linear-gradient(165deg,#E4F8EA,#D6F3E0)`, 42px rounded-square icon `#34C759` (two overlapping circles = group), name "Downstairs" (16px/700), subtitle "Living Room + Kitchen · <track>" in `#2A7D43`, animated 3-bar equalizer. This card is the **only controllable unit** while the group is active.
- **Caption under it:** green dot + "MULTIROOM SETUP SYNCED FROM RAUMFELD" (11px/600 `#8E8E93`).
- **Playing tile (single, ungrouped):** blue tint `linear-gradient(165deg,#E7F0FF,#DCEAFF)`, icon square `#0A84FF`, animated eq bars, name + track subtitle.
- **Locked member tile:** background `#F7F7FA`, grey speaker icon on `#E5E5EA`, a **padlock** glyph top-right, name in `#8E8E93`, subtitle "In Downstairs · in use" in `#AEAEB2`. Represents a HomeKit accessory that is present but **not individually operable** because its room is currently bound into an active Raumfeld group (see Behavior).
- **Off tile:** white bg, grey icon, subtitle "<model> · Off".
- **Footnote:** ⓘ + "Rooms in a Raumfeld group are controlled together — ungroup them in the Raumfeld app to use them on their own."

**Screen B — Now Playing**
- Dark sheet (default `linear-gradient(180deg,#2C2C2E,#1C1C1E)`; alt Midnight/Graphite). Album-art placeholder, track title (22px/700 white) + artist (`rgba(255,255,255,0.6)`), scrubber (34% filled, times 1:58 / -3:41), transport with 62px round play button in accent `#0A84FF`, volume slider (62%), and an **AirPlay route card** (accent border) reading "AirPlay · 2 rooms / Living Room + Kitchen".

**Screen C — In-app "Play Audio" AirPlay picker**
- **Purpose:** choose where this iPhone streams (the Control Center output list, surfaced inside the app).
- Header "Play Audio" + "Choose where to stream from this iPhone".
- Output list card: **iPhone** (source, unselected radio), then each zone as an AirPlay target. **Living Room** and **Kitchen** selected (accent-filled row `rgba(10,132,255,0.06)`, accent check circle). Bedroom / TV Room unselected (grey radio outline).
- Bottom mini bar in accent: "Streaming to 2 rooms / <track>".

### 1b — Plugin config screen  ← **BUILD THIS**
- **Purpose:** pair with the Raumfeld host and choose what to expose to HomeKit.
- **Container:** 560px card, `#F2F2F7`, 22px radius.
- **Header (white):** 46px app icon `linear-gradient(160deg,#0A84FF,#0060DF)`, "Raumfeld" (18px/700), monospace subtitle "v1.4.0 · host 192.168.178.42", and a **status pill**: green dot (pulsing) + "Connected" on `rgba(52,199,89,0.14)` / text `#248A3D`.
- **Sections** (iOS grouped-list style, 13px/600 `#8E8E93` headers, white 14px-radius cards, rows 13px pad, hairline separators `rgba(60,60,67,0.09)`):
  - **CONNECTION:** "Auto-discover host" toggle (on/green), "Raumfeld host" → `192.168.178.42` (mono).
  - **DEVICES EXPOSED TO HOMEKIT:** one row per device — 30px colored icon, name + model, iOS switch. Living Room (Stereo L, on), Kitchen (One, on), Bedroom (One M, on), TV Room (Soundbar, on), Connector (streaming bridge, hidden/off — greyed).
  - **AIRPLAY BRIDGE:** "Enable AirPlay streaming" toggle (accent) + subtitle "Expose zones as AirPlay 2 receivers"; "Audio buffer" → 220 ms.
  - **MULTIROOM:** "Expose groups as accessories" (on), "Sync group volume" (on).
  - **ZONE GROUPS · imported live from the Raumfeld app** (read-only): each group is a row with a colored group icon, name, "Master: <room>", and member chips (Downstairs = Living Room + Kitchen; Whole Home = all four). An **Ungrouped speakers** sub-row (Office · Stereo M). Closing note: "Groups are created in the Raumfeld app. Members are locked in HomeKit while the group is active."
  - **Save Changes** button (accent, 14px radius) + "Restart Homebridge to apply changes".
- iOS switch spec: 51×31 track, 27px white knob, on = `#34C759` (or accent for AirPlay), off = `#E5E5EA` with knob left.

### 1c — Architecture (implement this data flow)
Three lanes with labeled connectors:
- **iOS · Apple Home** (Home app & Siri, Control Center, iPhone audio)
  - ⇄ **HAP** ⇄ (bidirectional) and **AirPlay 2** → (one-way stream into plugin)
- **Homebridge plugin** (HAP accessory bridge → Speaker + fan(volume) services; Discovery SSDP/UPnP; **AirPlay 2 receiver** → re-streams to zone renderer; Zone/group mapper)
  - ⇄ **UPnP / OpenHome** ⇄ and **PCM stream** → (into renderer)
- **Teufel Raumfeld** (Raumfeld host = media & zone controller; Zone renderers = OpenHome playlists; Speakers Stereo L/M · One · Soundbar)

### 1d — Landing / README page
Hero: `homebridge-raumfeld` badge, headline "Raumfeld, in Apple Home.", subhead, install block `npm i -g homebridge-raumfeld` (dark, `$` in green), GitHub / Documentation buttons, meta row (v1.4.0 · MIT · 4.2k weekly · Homebridge v1.8+), screenshot placeholder. 3×2 feature grid: Auto-discovery, Native Home tiles, AirPlay 2 streaming, Multiroom groups, Per-zone volume, Siri control. "Tested with" chips: Stereo L/M, One/One M, Stream, Soundbar, Connector.

## Interactions & Behavior (the important logic)

### Discovery & pairing
- On launch, SSDP-search for the Raumfeld host; fall back to a manual host field. Poll the host's zone API (default 2 s; configurable). Cache discovered devices as HomeKit accessories; restore from cache on restart.

### HomeKit accessory model per zone
- Expose a `Television`/`SmartSpeaker` or `Speaker`+`Lightbulb`(as volume) service — pick per Homebridge conventions. Characteristics: Active/On, Mute, Volume, and (if available) current media title for logs. Map HomeKit volume 0–100 ↔ Raumfeld volume.

### Multiroom — the key rule requested
- **Groups are authored in the Raumfeld app**, not in Homebridge. The plugin reads zone membership from the host (`/getZones`) and mirrors it live (GENA eventing or poll).
- When rooms are combined into a Raumfeld zone, the plugin **exposes the group as one accessory** (the controllable unit) and **marks each member accessory as in-use / not independently controllable**:
  - Reflect this in HomeKit by setting the member accessory's controls to a non-responsive state — e.g. report it as `Active = InUse`/not-responding for direct control, or route any write on a member to a no-op while surfacing status. Home renders it as the greyed "In Downstairs · in use" tile with a padlock.
  - Writes (play/pause/volume) go to the **group/lead renderer**; group volume sync is toggleable.
- When the group is dissolved in the Raumfeld app, members become individually controllable again and the group accessory disappears (or goes idle). Handle add/remove of accessories cleanly (don't orphan cache entries).

### AirPlay
- Each zone (and each group) is optionally advertised as an AirPlay receiver. Selecting it in the iOS output picker starts a receiver session that decodes and pushes PCM into that zone's renderer. Selecting a group streams to all its members in sync. Reflect active AirPlay routing back as the zone's current source.

### Config UI behavior
- Toggling a device row includes/excludes that accessory from HomeKit (add/remove on save). Zone-group list is read-only (synced). Status pill reflects live host connectivity. "Save" persists to `config.json` and prompts restart.

## State Management
- **Host connection:** discovered | connecting | connected | error (drives status pill).
- **Device registry:** map of udn → {name, model, roomName, exposed, volume, playState, groupId|null}.
- **Group registry:** map of groupId → {name, leadRoom, memberUdns[], volume}. Derived from host; members' `groupId` set → member accessory locked.
- **AirPlay sessions:** map of zoneId → active receiver session.
- Data source: host zone API + GENA/poll; HomeKit characteristic get/set handlers read/write this registry.

## Design Tokens
- **Accent (iOS blue):** `#0A84FF` (config also offers `#34C759`, `#FF375F`, `#BF5AF2`).
- **Green (on/playing):** `#34C759`; group-text `#2A7D43` / `#248A3D`.
- **Purple group:** `#AF52DE` (chips `rgba(175,82,222,0.12)` / text `#8944AB`).
- **Grouped-blue chips:** `rgba(10,132,255,0.14)` / text `#0A84FF`.
- **Text:** primary `#1C1C1E`, secondary `#48484A`, tertiary `#8E8E93`, disabled `#AEAEB2`, faint `#C7C7CC`.
- **Surfaces:** grouped bg `#F2F2F7`, card white `#FFFFFF`, inset `#F7F7FA`, control fill `#E5E5EA`, desk `#E9E9EE`.
- **Separator:** `rgba(60,60,67,0.09–0.14)`.
- **Radii:** tile 18, card 14/22, icon 10–12, switch/pill 999.
- **Type:** `-apple-system, "SF Pro Display/Text", system-ui`; mono `ui-monospace, "SF Mono", Menlo`. Title 32–46/700, body 15–19, labels 12–13.
- **Shadows:** cards `0 30px 60px -35px rgba(0,0,0,0.3)`; phone `0 40px 80px -30px rgba(0,0,0,0.45)`.
- **Switch:** 51×31 track, 27px knob, knob shadow `0 2px 4px rgba(0,0,0,0.2)`.

## Assets
No bitmap assets. All icons are simple CSS shapes (speaker = rounded rect + two dots; group = two overlapping circles; soundbar = wide rect + 3 dots; padlock = body + arc; AirPlay = rect + triangle). Replace with SF Symbols in the real Home experience; use an icon set of your choice in the config UI. Album art / screenshots are striped placeholders — swap for real media metadata / screenshots.

## Files
- `Raumfeld Homebridge.dc.html` — the full design (badges 1a–1d). Open in a browser to view. Use the config surface `1b` and the flow `1c` as the primary implementation references.
