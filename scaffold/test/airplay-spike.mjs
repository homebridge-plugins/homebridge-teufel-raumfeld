// AirPlay feasibility spike — DOES A RAUMFELD RENDERER PLAY A FOREIGN HTTP URL?
//
// This is the make-or-break test for the AirPlay re-serve path. It points a
// renderer at an ordinary HTTP audio URL via SetAVTransportURI and issues Play.
//   - Plays  -> the "receiver -> re-serve as URL -> renderer pulls it" approach
//               is viable; AirPlay-1/node_airtunes2 milestone can proceed.
//   - Rejects (SOAP 7xx / silence) -> Raumfeld won't accept foreign sources;
//               the re-serve approach is dead, keep AirPlay gated.
//
// Build first (compiles src -> dist), then run:
//   npm run build
//   node test/airplay-spike.mjs <streamUrl> [rendererNameOrUdn] [host]
//
// Example (host any reachable HTTP audio file — mp3/wav/flac):
//   node test/airplay-spike.mjs http://192.168.1.50:8080/test.mp3 "Kitchen"
//
// If host is omitted it is SSDP-discovered. If rendererNameOrUdn is omitted the
// script lists rooms/zones and exits so you can pick one.

import { RaumfeldClient } from '../dist/raumfeldClient.js';

// Minimal Homebridge-Logging shim (client only calls info/warn/error/debug).
const log = Object.assign(
  (...a) => console.log('[log]', ...a),
  {
    info: (...a) => console.log('[info]', ...a),
    warn: (...a) => console.warn('[warn]', ...a),
    error: (...a) => console.error('[error]', ...a),
    debug: (...a) => console.log('[debug]', ...a),
    success: (...a) => console.log('[ok]', ...a),
    log: (...a) => console.log('[log]', ...a),
  },
);

const [streamUrl, pick, hostArg] = process.argv.slice(2);

if (!streamUrl) {
  console.error('usage: node test/airplay-spike.mjs <streamUrl> [rendererNameOrUdn] [host]');
  process.exit(2);
}

const host = hostArg ?? (await RaumfeldClient.discover(log));
if (!host) {
  console.error('No Raumfeld host given and SSDP discovery found none. Pass the host IP as arg 3.');
  process.exit(1);
}

const client = new RaumfeldClient(host, log);
try {
  await client.connect();
  const rooms = await client.getRooms();
  const zones = await client.getZones();

  // Flatten to selectable control targets: each room + each zone's lead renderer.
  const targets = [
    ...rooms.map((r) => ({ kind: 'room', name: r.name, udn: r.rendererUdn })),
    ...zones.map((z) => ({ kind: 'zone', name: z.name, udn: z.leadRendererUdn })),
  ];

  console.log('\nControl targets:');
  for (const t of targets) console.log(`  [${t.kind}] ${t.name}  ->  ${t.udn}`);

  if (!pick) {
    console.log('\nNo target selected. Re-run with the name or renderer udn as arg 2.');
    process.exit(0);
  }

  const target = targets.find((t) => t.udn === pick)
    ?? targets.find((t) => t.name.toLowerCase() === pick.toLowerCase());
  if (!target) {
    console.error(`\nNo room/zone matched "${pick}". Pick one from the list above.`);
    process.exit(1);
  }

  console.log(`\nTargeting [${target.kind}] ${target.name} (${target.udn})`);
  console.log(`SetAVTransportURI -> ${streamUrl}`);
  await client.setAvTransportUri(target.udn, streamUrl);
  console.log('SetAVTransportURI accepted (no SOAP fault). Issuing Play…');
  await client.setPlayState(target.udn, 0); // 0 = PLAY
  console.log('\nPlay issued. LISTEN: is the speaker playing the stream?');
  console.log('  yes -> foreign-URL playback works; AirPlay re-serve path is viable.');
  console.log('  no / SOAP fault above -> renderer rejects foreign sources; keep AirPlay gated.');
} catch (err) {
  console.error('\nSPIKE FAILED:', err?.message ?? err);
  console.error('A SOAP fault (HTTP 500/7xx) here strongly suggests the renderer refuses foreign URIs.');
  process.exitCode = 1;
} finally {
  client.dispose();
}
