/**
 * Unit tests for src/db/sshTunnel.js against a real in-process SSH server
 * (ssh2's own Server class) — no external sshd/Docker needed, so this runs
 * in CI. Separately live-verified against a real sshd (linuxserver/
 * openssh-server) tunneling to a real Postgres — this test covers the same
 * mechanics (forwardOut → direct-tcpip → piped duplex) self-contained.
 *
 * Keys are RSA/PKCS1 PEM, generated with Node's own `crypto` — ssh2 parses
 * that format directly; an ed25519 key from `crypto.generateKeyPairSync`
 * does *not* parse (needs the OpenSSH-specific encoding `ssh-keygen`
 * produces), which is exactly why this test doesn't use ed25519.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const ssh2 = require('ssh2');
const { openTunnel } = require('../../src/db/sshTunnel');

function generateRsaPem() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return privateKey;
}

/** A minimal SSH server: accepts any auth attempt, optionally allows forwarding. */
function startFakeSshServer({ allowForwarding = true } = {}) {
  const server = new ssh2.Server({ hostKeys: [generateRsaPem()] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('error', () => {});
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        if (!allowForwarding) return reject();
        const channel = accept();
        const socket = net.connect(info.destPort, info.destIP, () => {
          channel.pipe(socket).pipe(channel);
        });
        socket.on('error', () => channel.close());
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('openTunnel forwards a real connection end to end through a real SSH session', async () => {
  const sshServer = await startFakeSshServer();
  const target = net.createServer((socket) => {
    socket.on('data', (d) => socket.write(`echo:${d}`));
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));

  const tunnel = await openTunnel({
    host: '127.0.0.1',
    port: sshServer.address().port,
    username: 'anyone',
    privateKey: generateRsaPem(),
    dstHost: '127.0.0.1',
    dstPort: target.address().port,
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const client = net.connect(tunnel.localPort, '127.0.0.1', () => client.write('hi'));
      client.on('data', (d) => { client.end(); resolve(d.toString()); });
      client.on('error', reject);
    });
    assert.equal(result, 'echo:hi');
  } finally {
    tunnel.close();
    await new Promise((resolve) => target.close(resolve));
    await new Promise((resolve) => sshServer.close(resolve));
  }
});

test('a forwarded connection is refused (not hung) when the SSH server disallows forwarding', async () => {
  const sshServer = await startFakeSshServer({ allowForwarding: false });
  const tunnel = await openTunnel({
    host: '127.0.0.1',
    port: sshServer.address().port,
    username: 'anyone',
    privateKey: generateRsaPem(),
    dstHost: '127.0.0.1',
    dstPort: 1,
  });

  try {
    const closedCleanly = await new Promise((resolve) => {
      const client = net.connect(tunnel.localPort, '127.0.0.1');
      client.on('close', () => resolve(true));
      client.on('error', () => {}); // a reset here is expected, not a test failure
    });
    assert.equal(closedCleanly, true);
  } finally {
    tunnel.close();
    await new Promise((resolve) => sshServer.close(resolve));
  }
});

test('openTunnel rejects (does not hang) when the SSH server is unreachable', async () => {
  await assert.rejects(
    openTunnel({
      host: '127.0.0.1', port: 1, username: 'x', privateKey: generateRsaPem(),
      dstHost: 'x', dstPort: 1,
    }),
    /SSH tunnel failed/,
  );
});

test('openTunnel rejects (does not hang) on a bad private key', async () => {
  const sshServer = await startFakeSshServer();
  try {
    await assert.rejects(
      openTunnel({
        host: '127.0.0.1', port: sshServer.address().port, username: 'anyone',
        privateKey: 'not a real key', dstHost: '127.0.0.1', dstPort: 1,
      }),
      /SSH tunnel failed/,
    );
  } finally {
    await new Promise((resolve) => sshServer.close(resolve));
  }
});
