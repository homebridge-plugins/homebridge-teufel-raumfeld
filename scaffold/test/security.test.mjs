import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { AirPlayStreamServer } from '../dist/airplayStreamServer.js';
import { isPrivateHost, isPrivateIPv4, privateHttpUrl } from '../dist/net.js';
import { ssdpSearch } from '../dist/ssdpClient.js';

const log = { info() {}, debug() {}, warn() {}, error() {} };

test('private-address guard admits LAN ranges and rejects everything else', () => {
  for (const address of ['10.0.0.1', '10.168.11.39', '172.16.0.1', '172.31.255.254', '192.168.1.50', '100.64.0.1']) {
    assert.equal(isPrivateIPv4(address), true, `${address} should be private`);
  }
  // Loopback is the Homebridge admin API; 169.254.169.254 is cloud metadata.
  for (const address of ['127.0.0.1', '169.254.169.254', '0.0.0.0', '8.8.8.8', '172.32.0.1', '100.128.0.1']) {
    assert.equal(isPrivateIPv4(address), false, `${address} should be rejected`);
  }
  // Malformed input must not slip through via Number() coercion.
  for (const address of ['10.0.0', '10.0.0.1.1', '10.0.0.256', '10.0.0.0x1', '10.0.0. 1', '', 'not-an-ip']) {
    assert.equal(isPrivateIPv4(address), false, `${address} should be rejected`);
  }
});

test('hostnames are never treated as private, IPv6 ULA is', () => {
  // Rejecting hostnames is what closes DNS rebinding on network-supplied URLs.
  assert.equal(isPrivateHost('localhost'), false);
  assert.equal(isPrivateHost('raumfeld.local'), false);
  assert.equal(isPrivateHost('::1'), false);
  assert.equal(isPrivateHost('fd00::1'), true);
  assert.equal(isPrivateHost('[fd00::1]'), true);
  assert.equal(isPrivateHost('::ffff:192.168.1.5'), true);
  assert.equal(isPrivateHost('::ffff:8.8.8.8'), false);
});

test('privateHttpUrl rejects foreign schemes, public hosts, and loopback', () => {
  assert.equal(privateHttpUrl('http://192.168.1.50:47365/desc.xml')?.hostname, '192.168.1.50');
  assert.equal(privateHttpUrl('https://10.0.0.5/x')?.hostname, '10.0.0.5');

  for (const raw of [
    'http://127.0.0.1:8581/api/config',       // Homebridge admin API
    'http://169.254.169.254/latest/meta-data', // cloud metadata
    'http://evil.example.com/desc.xml',
    'file:///etc/passwd',
    'gopher://10.0.0.5/',
    'not a url',
  ]) {
    assert.equal(privateHttpUrl(raw), undefined, `${raw} should be rejected`);
  }
});

test('the stream token is rotated for every new session', async (t) => {
  const streamServer = new AirPlayStreamServer(log, 0, '127.0.0.1');
  await streamServer.start();
  t.after(() => streamServer.stop());

  streamServer.register('zone-a');
  const atRegister = tokenOf(streamServer.urlFor('zone-a'));

  streamServer.setSource('zone-a', new PassThrough());
  const firstSession = tokenOf(streamServer.urlFor('zone-a'));

  streamServer.clearSource('zone-a');
  streamServer.setSource('zone-a', new PassThrough());
  const secondSession = tokenOf(streamServer.urlFor('zone-a'));

  assert.notEqual(firstSession, atRegister);
  assert.notEqual(secondSession, firstSession);
  // A leaked URL from a previous session must not still authenticate.
  assert.equal(new Set([atRegister, firstSession, secondSession]).size, 3);
  assert.ok(firstSession.length >= 32, 'token should carry ~192 bits of entropy');
});

test('a malformed request-target is rejected instead of crashing the process', async (t) => {
  const streamServer = new AirPlayStreamServer(log, 0, '127.0.0.1');
  await streamServer.start();
  t.after(() => streamServer.stop());
  const port = streamServer.server.address().port;

  // Node accepts these request-targets and passes them to the handler, but the
  // WHATWG URL parser rejects them. Unguarded, the throw escaped the request
  // callback as an uncaught exception and took Homebridge down with it.
  for (const target of ['//[', '//[bad', '/airplay/%ZZ.wav']) {
    const status = await rawRequestStatus(port, target);
    assert.ok(status >= 400 && status < 500, `${target} should get a 4xx, got ${status}`);
  }
  // Still serving afterwards.
  assert.equal(await rawRequestStatus(port, '/nope'), 404);
});

test('ssdpSearch resolves without throwing on unusable bind addresses', async () => {
  // 203.0.113.1 (TEST-NET-3) is not assigned to any local interface, so the bind
  // fails; the search must swallow that and still resolve.
  const found = await ssdpSearch({ addresses: ['203.0.113.1'], timeoutMs: 150, log });
  assert.deepEqual(found, []);
});

/**
 * Send a request-target verbatim over a raw socket. `http.request` would
 * normalise or refuse these, which is exactly what the server must not rely on.
 */
function rawRequestStatus(port, target) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n`);
    });
    let buffer = '';
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error(`timed out on ${target}`)); });
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.on('error', reject);
    socket.on('close', () => {
      const status = /^HTTP\/1\.\d (\d{3})/.exec(buffer);
      if (!status) return reject(new Error(`no response for ${target}`));
      resolve(Number(status[1]));
    });
  });
}

function tokenOf(rawUrl) {
  const token = new URL(rawUrl).searchParams.get('token');
  assert.ok(token, 'stream URL should carry a token');
  return token;
}
