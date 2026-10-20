import net from 'node:net';
import { spawn } from 'node:child_process';

// Forward the native browser callback to the existing container without
// recreating it or publishing a port on a non-loopback interface. Callback
// bytes stay in the streams: no URL, query string or response is logged.
export async function startLoginForwarder(container, options = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) throw Error('invalid_container');
  const { port = 1455, remotePort = 1455, spawnProcess = spawn } = options;
  if (![port, remotePort].every(p => Number.isInteger(p) && p >= 0 && p <= 65535)) throw Error('invalid_callback_port');
  const clients = new Set(), children = new Set(), servers = [];
  let selectedPort = port;
  const close = async () => {
    for (const client of clients) client.destroy();
    for (const child of children) child.kill();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  };
  const relay = `const net=require('node:net');const s=net.connect({host:'127.0.0.1',port:${remotePort}},()=>{process.stdin.pipe(s);s.pipe(process.stdout)});s.on('error',()=>process.exit(1));s.on('end',()=>process.stdin.destroy());process.stdin.on('error',()=>s.destroy());process.stdout.on('error',()=>s.destroy());`;
  try {
    // Browsers can resolve localhost to either address. Claim both so an
    // unrelated listener cannot receive the callback on the other family.
    for (const host of ['127.0.0.1', '::1']) {
      const server = net.createServer({ allowHalfOpen: true }, client => {
        clients.add(client);
        client.on('error', () => {});
        const child = spawnProcess('docker', ['exec', '-i', container, 'node', '-e', relay], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        children.add(child);
        const finish = () => { child.kill(); children.delete(child); clients.delete(client); client.destroy(); };
        client.setTimeout(30_000, finish);
        client.once('close', finish);
        child.once('error', finish);
        child.once('close', () => { children.delete(child); client.end(); });
        child.stdin.on('error', () => client.destroy());
        child.stdout.on('error', () => client.destroy());
        client.pipe(child.stdin);
        child.stdout.pipe(client);
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host, port: selectedPort, ipv6Only: host === '::1' }, resolve);
      });
      servers.push(server);
      selectedPort = server.address().port;
    }
    return { port: selectedPort, close };
  } catch {
    await close();
    throw Error('localhost_callback_unavailable');
  }
}
