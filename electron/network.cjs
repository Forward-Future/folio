// A page owns its links, redirects, scripts and DNS names. Its Chromium session gets a private
// TCP-only SOCKS proxy: Chromium keeps its normal HTTP, TLS/SNI and certificate checks, while
// Folio opens the actual connection to a validated numeric address. No second target DNS lookup.
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const { once } = require("node:events");

const LOCAL = new net.BlockList();
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]]) {
  LOCAL.addSubnet(ip, prefix, "ipv4");
}
// Permit global unicast IPv6, excluding transition/documentation ranges which can embed IPv4.
const GLOBAL6 = new net.BlockList();
GLOBAL6.addSubnet("2000::", 3, "ipv6");
for (const [ip, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) LOCAL.addSubnet(ip, prefix, "ipv6");

const bare = (host) => host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
const localName = (host) => host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
function isLocalAddress(address) {
  const ip = bare(address);
  return net.isIPv4(ip) ? LOCAL.check(ip, "ipv4") : !net.isIPv6(ip) || !GLOBAL6.check(ip, "ipv6") || LOCAL.check(ip, "ipv6");
}

function connectedNetworks() {
  const networks = new net.BlockList();
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (!iface?.cidr) continue;
    const [ip, bits] = iface.cidr.split("/");
    networks.addSubnet(ip.split("%")[0], Number(bits), iface.family.toLowerCase());
  }
  return networks;
}

async function resolveDestination(url, resolver) {
  const host = bare(url.hostname);
  const addresses = net.isIP(host) ? [host] : (await resolver.resolveHost(host)).endpoints.map(e => e.address);
  if (!addresses.length || addresses.some(ip => !net.isIP(ip))) throw new Error("Couldn't resolve that address.");
  const networks = connectedNetworks();
  return { origin: url.origin, addresses, local: localName(host) || addresses.some(ip =>
    isLocalAddress(ip) || networks.check(ip, net.isIPv4(ip) ? "ipv4" : "ipv6")) };
}

// Read exactly one SOCKS field. Leave any pipelined application bytes in the socket.
async function readField(socket, length, signal) {
  while (!socket.destroyed) {
    const bytes = socket.read(length);
    if (bytes) return bytes;
    await once(socket, "readable", { signal });
  }
  throw new Error("Connection closed");
}

async function readTarget(socket, signal) {
  const read = (length) => readField(socket, length, signal);
  const [version, methods] = await read(2);
  if (version !== 5 || !methods || !(await read(methods)).includes(0)) throw new Error("Invalid greeting");
  socket.write(Buffer.from([5, 0]));
  const [v, command, reserved, type] = await read(4);
  if (v !== 5 || command !== 1 || reserved !== 0) throw new Error("Only TCP connections are supported");
  let host;
  if (type === 3) {
    const [length] = await read(1);
    if (!length) throw new Error("Missing hostname");
    host = (await read(length)).toString("ascii");
  } else if (type === 1) {
    host = Array.from(await read(4)).join(".");
  } else if (type === 4) {
    const words = (await read(16)).toString("hex").match(/.{4}/g);
    host = new URL("http://[" + words.join(":") + "]").hostname;
  } else throw new Error("Invalid address");
  const port = (await read(2)).readUInt16BE();
  return bare(host) + ":" + port;
}

// Honor the system route. An HTTP(S) proxy gets a numeric CONNECT authority as well. An
// unsupported proxy or failed tunnel must never silently become a direct connection.
async function connectPinned({ addresses, route, port }, signal) {
  const first = route.split(";")[0].trim();
  if (first === "DIRECT") {
    // Node can try both families, but its lookup can return only the addresses approved above.
    const endpoints = addresses.map(address => ({ address, family: net.isIP(address) }));
    const socket = net.connect({ host: "folio-pinned.invalid", port, signal, autoSelectFamily: true,
      lookup: (_host, options, cb) => options.all ? cb(null, endpoints) : cb(null, endpoints[0].address, endpoints[0].family) });
    await once(socket, "connect");
    return socket;
  }
  const proxy = /^(PROXY|HTTPS) (\S+)$/i.exec(first);
  if (!proxy) throw new Error("This system proxy cannot open a verified IP tunnel.");
  const secure = proxy[1].toUpperCase() === "HTTPS";
  const via = new URL((secure ? "https://" : "http://") + proxy[2]);
  const address = addresses[0];
  const authority = (net.isIPv6(address) ? "[" + address + "]" : address) + ":" + port;
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(via, { method: "CONNECT", path: authority, agent: false,
      headers: { host: authority }, signal });
    req.once("error", reject);
    req.once("connect", (res, socket, head) => {
      if (res.statusCode !== 200 || signal.aborted) { socket.destroy(); return reject(new Error("System proxy refused the IP tunnel.")); }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.end();
  });
}

async function guardSession(ses, system, approvedLocal) {
  const grants = new Map();
  const sockets = new Set();
  let denied = false;
  let closed = false;
  const server = net.createServer({ pauseOnConnect: true }, async client => {
    sockets.add(client);
    const stop = new AbortController();
    let upstream;
    client.on("error", () => client.destroy());
    client.on("close", () => { stop.abort(); upstream?.destroy(); sockets.delete(client); });
    client.setTimeout(15_000, () => client.destroy());
    try {
      const key = await readTarget(client, stop.signal);
      const grant = grants.get(key);
      if (!grant || closed) throw new Error("Unrequested destination");
      upstream = await connectPinned(grant, stop.signal);
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => client.destroy());
      if (client.destroyed || closed) { upstream.destroy(); return; }
      client.setTimeout(0);
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      client.pipe(upstream).pipe(client);
    } catch { client.destroy(); }
  });
  const close = () => {
    closed = true;
    ses.webRequest.onBeforeRequest((_request, callback) => callback({ cancel: true }));
    server.close();
    for (const socket of sockets) socket.destroy();
    grants.clear();
  };
  try {
    server.maxConnections = 128;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await ses.setProxy({ mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:" + server.address().port, proxyBypassRules: "<-loopback>" });
    ses.webRequest.onBeforeRequest(async (details, callback) => {
      try {
        const url = new URL(details.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") return callback({ cancel: !["data:", "blob:"].includes(url.protocol) });
        const [dest, route] = await Promise.all([resolveDestination(url, ses), system.resolveProxy(url.href)]);
        const allowedLocal = approvedLocal?.origin === dest.origin && dest.addresses.every(ip => approvedLocal.addresses.includes(ip));
        if (dest.local && !allowedLocal) { denied = true; return callback({ cancel: true }); }
        if (closed) return callback({ cancel: true });
        const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
        const key = bare(url.hostname) + ":" + port;
        // SOCKS identifies a connection only by host and port. Never let a concurrent request
        // replace the addresses, scope or route that an already-authorized connection will use.
        const existing = grants.get(key);
        if (existing) {
          if (existing.origin !== dest.origin || existing.local !== dest.local || existing.route !== route) {
            denied ||= existing.local || dest.local;
            return callback({ cancel: true });
          }
        } else {
          if (grants.size >= 1024) return callback({ cancel: true });
          grants.set(key, { ...dest, route, port });
        }
        callback({});
      } catch { callback({ cancel: true }); }
    });
    return { close, refusedLocal: () => denied };
  } catch (error) { close(); throw error; }
}

module.exports = { guardSession, resolveDestination, isLocalAddress };
