import assert from 'node:assert/strict';
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
  assert.equal(await requestStatus(authorizedUrl), 429);

  streamServer.clearSource('zone-1');
  assert.equal(await requestStatus(authorizedUrl), 503);
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
