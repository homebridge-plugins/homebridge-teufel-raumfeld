import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { AirPlayBridge } from '../dist/airplayBridge.js';
import { AirPlayStreamServer } from '../dist/airplayStreamServer.js';

const log = {
  info() {},
  debug() {},
  warn() {},
  error() {},
};

test('custom UI and polling schema match runtime behavior', async () => {
  const schema = JSON.parse(await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.customUi, true);
  assert.equal(schema.schema.properties.pollInterval.default, 30);
  assert.equal(schema.schema.properties.pollInterval.minimum, 30);
  assert.equal(schema.schema.properties.airplay.properties.bufferMs, undefined);
});

test('stream endpoint rejects malformed, unauthenticated, and inactive requests', async (t) => {
  const streamServer = new AirPlayStreamServer(log, 0, '127.0.0.1');
  await streamServer.start();
  t.after(() => streamServer.stop());

  const port = listeningPort(streamServer);
  streamServer.register('zone/example');
  const authorizedUrl = withPort(streamServer.urlFor('zone/example'), port);

  assert.equal(await requestStatus({ port, path: '/airplay/%ZZ.wav' }), 400);
  assert.equal(await requestStatus({ port, path: '/airplay/zone%2Fexample.wav' }), 404);
  assert.equal(await requestStatus(authorizedUrl), 503);
});

test('stream endpoint caps authenticated consumers and serves PCM only while active', async (t) => {
  const streamServer = new AirPlayStreamServer(log, 0, '127.0.0.1');
  await streamServer.start();
  t.after(() => streamServer.stop());

  const port = listeningPort(streamServer);
  const source = new PassThrough();
  streamServer.register('zone-1');
  streamServer.setSource('zone-1', source);
  const authorizedUrl = withPort(streamServer.urlFor('zone-1'), port);

  const first = await openStream(authorizedUrl);
  const second = await openStream(authorizedUrl);
  t.after(() => first.destroy());
  t.after(() => second.destroy());

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  // Raumfeld sinks advertise audio/x-wav only; audio/wav connects but stays silent.
  assert.equal(first.headers['content-type'], 'audio/x-wav');
  assert.equal(await requestStatus(authorizedUrl), 429);

  streamServer.clearSource('zone-1');
  assert.equal(await requestStatus(authorizedUrl), 503);
});

test('a new renderer connection gets the recent audio at once, not only the live rate', async (t) => {
  const streamServer = new AirPlayStreamServer(log, 0, '127.0.0.1');
  await streamServer.start();
  t.after(() => streamServer.stop());

  const source = new PassThrough();
  streamServer.register('zone-1');
  streamServer.setSource('zone-1', source);
  // One second of audio arrives before the renderer connects.
  const second = Buffer.alloc(44100 * 4, 7);
  source.write(second);
  await new Promise((resolve) => setImmediate(resolve));

  const res = await openStream(withPort(streamServer.urlFor('zone-1'), listeningPort(streamServer)));
  t.after(() => res.destroy());
  let received = 0;
  res.on('data', (chunk) => { received += chunk.length; });
  // A renderer fed only at the live rate never gets ahead and underruns.
  await waitFor(() => received >= 44 + second.length);
  assert.equal(received, 44 + second.length);
});

test('a failed port bind can be retried after the port becomes available', async (t) => {
  const blocker = createServer();
  await listen(blocker, 0);
  const address = blocker.address();
  assert(address && typeof address === 'object');

  const streamServer = new AirPlayStreamServer(log, address.port, '127.0.0.1');
  t.after(() => streamServer.stop());
  await assert.rejects(streamServer.start(), { code: 'EADDRINUSE' });

  await close(blocker);
  await streamServer.start();
  assert.equal(listeningPort(streamServer), address.port);
});

test('an unexpected receiver exit schedules a replacement while the target remains', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'raumfeld-airplay-test-'));
  const fakeShairport = join(fixtureDir, 'fake-shairport');
  await writeFile(
    fakeShairport,
    '#!/usr/bin/env node\nif (process.argv[2] === "-V") process.exit(0);\nprocess.exit(1);\n',
    { mode: 0o755 },
  );
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));

  const client = {
    async setAvTransportUri() {},
    async setPlayState() {},
  };
  // The fixture passes the availability check but exits immediately when
  // launched with normal shairport-sync arguments.
  const bridge = new AirPlayBridge(log, client, {
    enabled: true,
    binaryPath: fakeShairport,
    streamHost: '127.0.0.1',
    streamPort: 0,
  });
  t.after(() => bridge.stop());

  await bridge.syncTargets([{
    zoneId: 'restart-zone',
    name: 'Restart Zone',
    rendererUdn: 'renderer-1',
    memberUdns: [],
  }]);

  await waitFor(() => bridge.restartTimers.size === 1);
  assert.equal(bridge.sessions.size, 0);
  assert.equal(bridge.desiredTargets.has('restart-zone'), true);

  // A zone update during the backoff must not respawn the receiver early,
  // or a receiver that always crashes loops at the zone-update rate.
  const pending = bridge.restartTimers.get('restart-zone');
  await bridge.syncTargets([{
    zoneId: 'restart-zone',
    name: 'Restart Zone',
    rendererUdn: 'renderer-1',
    memberUdns: [],
  }]);
  assert.equal(bridge.sessions.size, 0);
  assert.equal(bridge.restartTimers.get('restart-zone'), pending);
  assert.equal(bridge.restartFailures.get('restart-zone'), 1);
});

test('receivers left running by a previous start are stopped, unrelated pids are not', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'raumfeld-airplay-test-'));
  const fakeShairport = join(fixtureDir, 'fake-shairport');
  // Passes the availability check, otherwise idles like a real receiver.
  await writeFile(
    fakeShairport,
    '#!/usr/bin/env node\nif (process.argv[2] === "-V") process.exit(0);\nsetInterval(() => {}, 1000);\n',
    { mode: 0o755 },
  );
  const pidFile = join(fixtureDir, 'raumfeld-airplay.pids');
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));

  const orphan = spawn(fakeShairport, ['-a', 'Old', '-o', 'stdout', '--port', '5000'], { stdio: 'ignore' });
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { orphan.kill('SIGKILL'); bystander.kill('SIGKILL'); });
  await waitFor(() => orphan.pid && bystander.pid);
  await writeFile(pidFile, `${orphan.pid}\n${bystander.pid}\n`);
  const orphanExit = new Promise((resolve) => orphan.once('exit', resolve));

  const bridge = new AirPlayBridge(log, { async setAvTransportUri() {}, async setPlayState() {} }, {
    enabled: true,
    binaryPath: fakeShairport,
    streamHost: '127.0.0.1',
    streamPort: 0,
    pidFile,
  });
  t.after(() => bridge.stop());
  await bridge.syncTargets([]);

  await orphanExit;
  assert.equal(bystander.exitCode, null);
  assert.equal(bystander.signalCode, null);
  assert.equal((await readFile(pidFile, 'utf8')).trim(), '');
});

test('an unassigned room plays through a zone created for it, not its own renderer', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'raumfeld-airplay-test-'));
  const fakeShairport = join(fixtureDir, 'fake-shairport');
  // Emits one PCM chunk (an AirPlay session starting), then idles.
  await writeFile(
    fakeShairport,
    '#!/usr/bin/env node\nif (process.argv[2] === "-V") process.exit(0);\n'
      + 'process.stdout.write(Buffer.alloc(4096));\nsetInterval(() => {}, 1000);\n',
    { mode: 0o755 },
  );
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));

  const calls = [];
  const client = {
    async zoneRendererForRoom(roomUdn) { calls.push(['zoneFor', roomUdn]); return 'uuid:new-zone'; },
    async setAvTransportUri(udn, _url, metadata) { calls.push(['uri', udn, metadata.includes('audio/x-wav')]); },
    async setPlayState(udn, state) { calls.push(['play', udn, state]); },
  };
  const bridge = new AirPlayBridge(log, client, {
    enabled: true,
    binaryPath: fakeShairport,
    streamHost: '127.0.0.1',
    streamPort: 0,
  });
  t.after(() => bridge.stop());

  await bridge.syncTargets([{
    zoneId: 'uuid:room-kitchen',
    name: 'Kitchen',
    rendererUdn: 'uuid:speaker-kitchen',
    memberUdns: [],
    unassignedRoomUdn: 'uuid:room-kitchen',
  }]);

  await waitFor(() => calls.length === 3);
  assert.deepEqual(calls, [
    ['zoneFor', 'uuid:room-kitchen'],
    ['uri', 'uuid:new-zone', true],
    ['play', 'uuid:new-zone', 0],
  ]);
});

test('receivers ignore the sender volume through the plugin-written config', async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'raumfeld-airplay-test-'));
  const fakeShairport = join(fixtureDir, 'fake-shairport');
  const argvFile = join(fixtureDir, 'argv.json');
  // Records its arguments, then idles like a real receiver.
  await writeFile(
    fakeShairport,
    '#!/usr/bin/env node\nif (process.argv[2] === "-V") process.exit(0);\n'
      + `require("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`
      + 'setInterval(() => {}, 1000);\n',
    { mode: 0o755 },
  );
  const configFile = join(fixtureDir, 'raumfeld-shairport.conf');
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));

  const bridge = new AirPlayBridge(log, { async setAvTransportUri() {}, async setPlayState() {} }, {
    enabled: true,
    binaryPath: fakeShairport,
    streamHost: '127.0.0.1',
    streamPort: 0,
    configFile,
  });
  t.after(() => bridge.stop());
  await bridge.syncTargets([{ zoneId: 'z', name: 'Zone', rendererUdn: 'uuid:z', memberUdns: [] }]);

  await waitFor(() => existsSync(argvFile));
  const argv = JSON.parse(await readFile(argvFile, 'utf8'));
  assert.equal(argv[argv.indexOf('-c') + 1], configFile);
  // At half iPhone volume shairport-sync otherwise scales the PCM by about -30 dB.
  assert.match(await readFile(configFile, 'utf8'), /ignore_volume_control = "yes";/);
});

function listeningPort(streamServer) {
  const address = streamServer.server?.address();
  assert(address && typeof address === 'object');
  return address.port;
}

function withPort(rawUrl, port) {
  const url = new URL(rawUrl);
  url.port = String(port);
  return url;
}

function requestStatus(target) {
  return new Promise((resolve, reject) => {
    const req = request(target, (res) => {
      const status = res.statusCode;
      res.destroy();
      resolve(status);
    });
    req.once('error', reject);
    req.end();
  });
}

function openStream(target) {
  return new Promise((resolve, reject) => {
    const req = request(target, resolve);
    req.once('error', reject);
    req.end();
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
