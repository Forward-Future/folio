const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const { resolveDestination, guardSession } = require("../electron/network.cjs");

function resolver(...addresses) {
  return { resolveHost: async () => ({ endpoints: addresses.map(address => ({ address })) }) };
}

test("unknown, local, mixed and transition addresses cannot silently become public", async () => {
  const url = new URL("https://document.test");
  for (const ip of ["0.1.2.3", "100.64.0.2", "127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "fe80::1"]) {
    assert.equal((await resolveDestination(url, resolver("8.8.8.8", ip))).local, true, ip);
  }
  assert.equal((await resolveDestination(new URL("https://printer.local./"), resolver("8.8.8.8"))).local, true);
  await assert.rejects(resolveDestination(url, resolver()), /resolve/);
  await assert.rejects(resolveDestination(url, resolver("not-an-address")), /resolve/);
});

test("two origins sharing a SOCKS address cannot substitute their grants or routes", async () => {
  const publicUrl = new URL("http://alias.test:8000/doc");
  const localUrl = new URL("http://alias.test.:8000/doc");
  const local = await resolveDestination(localUrl, resolver("127.0.0.1"));
  const session = { ...resolver("8.8.8.8"), setProxy: async () => {},
    webRequest: { onBeforeRequest: fn => { session.authorize = url => new Promise(resolve => fn({ url: url.href }, resolve)); } } };
  const system = { resolveProxy: async () => "DIRECT" };
  const guard = await guardSession(session, system, local);
  try {
    assert.deepEqual(await session.authorize(publicUrl), {});
    session.resolveHost = resolver("127.0.0.1").resolveHost;
    assert.deepEqual(await session.authorize(localUrl), { cancel: true });
    session.resolveHost = resolver("8.8.8.8").resolveHost;
    assert.deepEqual(await session.authorize(new URL("https://alias.test:8000/doc")), { cancel: true });
    system.resolveProxy = async () => "PROXY different.test:3128";
    assert.deepEqual(await session.authorize(publicUrl), { cancel: true });
  } finally { guard.close(); }
});

test("the system proxy gets a pinned numeric CONNECT; Chromium's tunnel stays transparent", { timeout: 5000 }, async () => {
  // Simulate an upstream HTTP proxy without contacting any non-loopback destination.
  const upstream = http.createServer();
  const targets = [];
  const peers = new Set();
  upstream.on("connect", (req, peer) => {
    targets.push(req.url);
    peers.add(peer);
    peer.on("error", () => {});
    peer.on("close", () => peers.delete(peer));
    peer.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    peer.pipe(peer);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const url = new URL("https://origin.test/one");
  // The check also works on machines where the test IPv4 range belongs to a local interface.
  const session = { ...resolver("8.8.8.8"), setProxy: async config => { session.config = config; },
    webRequest: { onBeforeRequest: listener => { session.authorize = listener; } } };
  const system = { resolveProxy: async () => "PROXY 127.0.0.1:" + upstream.address().port };
  const guard = await guardSession(session, system, await resolveDestination(url, session));
  const client = new net.Socket();
  try {
    const result = await new Promise(resolve => session.authorize({ url: url.href }, resolve));
    assert.deepEqual(result, {});
    assert.equal(session.config.proxyBypassRules, "<-loopback>");
    const proxy = new URL(session.config.proxyRules);
    client.connect(Number(proxy.port), proxy.hostname);
    await once(client, "connect");
    let got = Buffer.alloc(0);
    const payload = Buffer.from("transparent tunnel");
    const complete = new Promise((resolve, reject) => {
      client.on("data", bytes => {
        got = Buffer.concat([got, bytes]);
        if (got.length >= 12 + payload.length) resolve();
      });
      client.on("error", reject);
      client.on("close", resolve);
    });
    // Pipeline the greeting, domain-format request and payload. The proxy cannot consume the first TLS/HTTP bytes.
    const host = Buffer.from(url.hostname);
    client.write(Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, host.length]), host, Buffer.from([1, 187]), payload]));
    await complete;
    assert.deepEqual(targets, ["8.8.8.8:443"]);
    assert.equal(got[1], 0);
    assert.equal(got[3], 0);
    assert.deepEqual(got.subarray(12), payload);
  } finally {
    client.destroy();
    guard.close();
    for (const peer of peers) peer.destroy();
    upstream.close();
  }
});
