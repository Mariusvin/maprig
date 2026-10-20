import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { startLoginForwarder } from './local-agent-login-forwarder.mjs';

const listen = (server, options) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(options, resolve); });
const close = server => new Promise(resolve => server.close(resolve));
function request(host, port, bytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const client = net.connect({ host, port }, () => client.end(bytes));
    client.setTimeout(5000, () => client.destroy(Error('fixture_callback_timed_out')));
    client.on('data', bytes => chunks.push(bytes));
    client.on('error', reject);
    client.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

test('browser callbacks reach the container stream from both loopback families', async t => {
  const observed = [];
  const native = net.createServer(client => {
    client.on('data', bytes => { observed.push(bytes.toString()); client.end('fixture-callback-received'); });
  });
  await listen(native, { host: '127.0.0.1', port: 0 });
  t.after(() => close(native));
  const forwarder = await startLoginForwarder('fixture-container', {
    port: 0, remotePort: native.address().port,
    spawnProcess(command, args, options) {
      assert.equal(command, 'docker');
      assert.deepEqual(args.slice(0, 5), ['exec', '-i', 'fixture-container', 'node', '-e']);
      assert.equal(options.stdio[2], 'ignore');
      return spawn(process.execPath, args.slice(4), options);
    },
  });
  t.after(() => forwarder.close());
  const callback = 'GET /auth/callback?code=fixture-private-code&state=fixture-state HTTP/1.1\r\n\r\n';
  for (const host of ['127.0.0.1', '::1']) assert.equal(await request(host, forwarder.port, callback), 'fixture-callback-received');
  assert.deepEqual(observed, [callback, callback]);
});

test('an occupied callback port is refused without taking over its listener', async t => {
  const existing = net.createServer(client => client.end('fixture-existing'));
  await listen(existing, { host: '127.0.0.1', port: 0 });
  t.after(() => close(existing));
  await assert.rejects(startLoginForwarder('fixture-container', { port: existing.address().port }), /localhost_callback_unavailable/);
  assert.equal(existing.listening, true);
});

test('invalid callback destinations are rejected before opening listeners', async () => {
  await assert.rejects(startLoginForwarder('bad/container'), /invalid_container/);
  await assert.rejects(startLoginForwarder('fixture', { port: -1 }), /invalid_callback_port/);
});
