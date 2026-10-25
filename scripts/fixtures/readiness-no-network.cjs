// A Node-process boundary, not an OS sandbox or protection for native children.
const { permittedSystemKeys, syntheticProcessEnvironment } = require("./readiness-isolation-profile.mjs");
const fixedEnvironment = syntheticProcessEnvironment();
const allowedEnvironment = new Set([...permittedSystemKeys, ...Object.keys(fixedEnvironment), "NODE_TEST_CONTEXT"].map(key => key.toUpperCase()));
// Windows may reinsert user-profile variables even for an explicit spawn env.
// Remove them before application/test imports; never inspect or print values.
for (const key of Object.keys(process.env)) if (!allowedEnvironment.has(key.toUpperCase())) delete process.env[key];
for (const [key, value] of Object.entries(fixedEnvironment)) process.env[key] = value;
const { syncBuiltinESMExports } = require("node:module");
const attempts = new Map();
function denied(kind) {
  attempts.set(kind, (attempts.get(kind) || 0) + 1);
  const error = new Error(`Synthetic transport forbidden: ${kind}`);
  error.code = "MEDINA_SYNTHETIC_NETWORK_DENIED";
  throw error;
}
const refuse = kind => function () { return denied(kind); };
for (const protocol of ["http", "https"]) {
  const module = require(`node:${protocol}`);
  for (const method of ["request", "get"]) module[method] = refuse(`${protocol}.${method}`);
}
require("node:http2").connect = refuse("http2.connect");
const net = require("node:net");
net.connect = refuse("net.connect");
net.createConnection = refuse("net.createConnection");
net.Socket.prototype.connect = refuse("Socket.connect");
net.Server.prototype.listen = refuse("Server.listen");
require("node:tls").connect = refuse("tls.connect");
require("node:dgram").createSocket = refuse("dgram.createSocket");
const dns = require("node:dns");
for (const method of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]) {
  if (typeof dns[method] === "function") dns[method] = refuse(`dns.${method}`);
  if (typeof dns.promises[method] === "function") dns.promises[method] = async function () { return denied(`dns.promises.${method}`); };
}
for (const Resolver of [dns.Resolver, dns.promises.Resolver]) {
  for (const method of Object.getOwnPropertyNames(Resolver.prototype)) {
    if (/^(resolve|reverse)/.test(method)) Resolver.prototype[method] = refuse(`dns.Resolver.${method}`);
  }
}
globalThis.fetch = async function () { return denied("fetch"); };
globalThis.WebSocket = class { constructor() { denied("WebSocket"); } };
if (globalThis.EventSource) globalThis.EventSource = class { constructor() { denied("EventSource"); } };
syncBuiltinESMExports();
// Even a caught unexpected attempt fails the process. No URL/header/body values
// are logged, and application code cannot clear this private evidence.
process.on("exit", () => {
  if (!attempts.size) return;
  process.stderr.write(`Synthetic network attempts refused: ${[...attempts].map(([kind, count]) => `${kind}=${count}`).join(", ")}\n`);
  process.exitCode = 86;
});
