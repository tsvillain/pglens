/**
 * SSH tunnel for connecting to a Postgres instance only reachable through a
 * bastion/jump host. Single-hop only (no jumphost chaining) and key-based
 * auth only — the common case; extend if a real need for more shows up.
 *
 * Opens a real SSH connection and a local TCP listener; every accepted
 * local connection is forwarded through the SSH session to the target
 * host/port via `forwardOut`. `postgres()` then connects to the local
 * listener instead of the real host — the target Postgres never needs to
 * be reachable from this machine directly.
 */

const net = require('net');
const { Client } = require('ssh2');

function openTunnel({ host, port = 22, username, privateKey, passphrase, dstHost, dstPort }) {
  return new Promise((resolve, reject) => {
    const ssh = new Client();
    let localServer;
    let settled = false;

    const cleanup = () => {
      try { localServer?.close(); } catch { /* already closed */ }
      try { ssh.end(); } catch { /* already ended */ }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    ssh.on('error', (err) => fail(new Error(`SSH tunnel failed: ${err.message}`)));

    ssh.on('ready', () => {
      localServer = net.createServer((socket) => {
        ssh.forwardOut(
          socket.remoteAddress || '127.0.0.1',
          socket.remotePort || 0,
          dstHost,
          dstPort,
          (err, stream) => {
            if (err) {
              socket.destroy();
              return;
            }
            socket.pipe(stream).pipe(socket);
            stream.on('error', () => socket.destroy());
            socket.on('error', () => stream.destroy());
          },
        );
      });

      localServer.on('error', (err) => fail(new Error(`SSH tunnel local listener failed: ${err.message}`)));

      localServer.listen(0, '127.0.0.1', () => {
        if (settled) return; // already failed between listen() and this callback
        settled = true;
        resolve({ localPort: localServer.address().port, close: cleanup });
      });
    });

    // ssh2 throws synchronously here for some failures (e.g. an unparseable
    // key) instead of emitting 'error' — route both through the same
    // wrapper so callers get a consistent message either way.
    try {
      ssh.connect({ host, port, username, privateKey, passphrase });
    } catch (err) {
      fail(new Error(`SSH tunnel failed: ${err.message}`));
    }
  });
}

module.exports = { openTunnel };
