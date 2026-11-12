import { isDeepStrictEqual } from "node:util";
import { createAdvertisingReportsHttpFixture } from "./advertising-reports-http-store.mjs";

// Synthetic middleware only: no listener, environment, persistence, SDK, or outbound I/O.
const W1 = "aaaaaaaa-1111-4111-8111-111111111111";
const CONTROL = "/__fixture/telegram-delivery";
const VIDEOS = "/api/crm/content-videos";
const SEND = "/api/content-studio/send-telegram";
const READS = new Set(["/api/crm/auth-context", "/api/content-studio/status", "/api/content-studio/usage"]);
const MODES = ["success", "hold-headers", "hold-body", "partial"];
const MAX_BODY = 40 * 1024;
const MAX_ACTIVE = 32;
const MAX_CONTROLS = 8;
const MAX_JOURNAL = 64;
const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff" };
const copy = (value) => JSON.parse(JSON.stringify(value));
const ok = (data) => ({ success: true, mode: "supabase", data });
const denied = (status) => ({ success: false, error: `TEST ONLY: synthetic fixture request denied (${status})` });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const nextVersion = (video) => new Date(Date.parse(video.updatedAt) + 1).toISOString().replace("Z", "000Z");

function seed(actor) {
  return {
    id: actor === "A" ? "a7000000-1111-4111-8111-111111111111" : "b7000000-2222-4222-8222-222222222222",
    title: `QA Telegram ${actor} - synthetic package`, niche: `QA ${actor} fabricated service`,
    goal: "QA fabricated goal", duration: "30 seconds", style: "QA fabricated style", audience: "QA adults",
    hook: `QA ${actor} hook`, script: actor === "A" ? "A".repeat(7000) : "QA B script",
    voiceover: `QA ${actor} voiceover`, cta: `QA ${actor} CTA`, caption: `QA ${actor} caption`,
    hashtags: [`#QA${actor}`, "#Synthetic"], avatarPrompt: `QA ${actor} avatar prompt`, tapnowPrompt: `QA ${actor} TapNow prompt`,
    status: "idea", createdAt: "2026-10-23T08:00:00.000Z", updatedAt: "2026-10-23T08:00:00.123456Z",
  };
}

// Kept byte-for-byte compatible with ContentStudio's buildTelegramPackage, not the API formatter.
function buildTelegramPackage(video) {
  return [
    `\u0418\u0418 \u0441\u0442\u0443\u0434\u0438\u044f \u043a\u043e\u043d\u0442\u0435\u043d\u0442\u0430: ${video.title}`,
    video.hook ? `Hook:\n${video.hook}` : null,
    video.script ? `Script:\n${video.script}` : null,
    video.voiceover ? `Voiceover:\n${video.voiceover}` : null,
    video.cta ? `CTA:\n${video.cta}` : null,
    video.caption ? `Caption:\n${video.caption}` : null,
    video.hashtags?.length ? `Hashtags:\n${video.hashtags.join(" ")}` : null,
    video.avatarPrompt ? `Avatar prompt:\n${video.avatarPrompt}` : null,
    video.tapnowPrompt ? `TapNow prompt:\n${video.tapnowPrompt}` : null,
  ].filter(Boolean).join("\n\n---\n\n");
}

function singleHeaders(req) {
  const counts = new Map();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index].toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return ["host", "origin", "authorization", "content-type", "content-encoding", "content-length"]
    .every((name) => (counts.get(name) ?? 0) <= 1);
}

function loopbackOrigin(req) {
  if (!singleHeaders(req) || req.socket.encrypted
    || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) return null;
  const host = req.headers.host;
  if (typeof host !== "string" || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9]\d{0,4})?$/.test(host)) return null;
  try {
    const url = new URL(`http://${host}`);
    if (url.host !== host || (req.headers.origin !== undefined && req.headers.origin !== url.origin)) return null;
    return url.origin;
  } catch { return null; }
}

/** Bounded native HTTP middleware. Main owns the loopback server and Vite wiring. */
export function createTelegramDeliveryHttpFixture() {
  let reports = createAdvertisingReportsHttpFixture();
  let videos = { A: seed("A"), B: seed("B") };
  let mode = "success", epoch = 0, sequence = 0, closed = false;
  let received = [], totals = { received: 0, completed: 0, aborted: 0, statusWrites: 0 };
  const active = new Set(), pending = new Map();

  function snapshot() {
    return copy({ mode, pending: [...pending.values()].map(({ id, actor, test, phase }) => ({ id, actor, test, phase })),
      received, receivedCount: totals.received, completed: totals.completed, aborted: totals.aborted,
      statusWrites: totals.statusWrites, inFlight: active.size, externalCalls: 0, closed });
  }

  function send(res, status, body) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, HEADERS);
    res.end(JSON.stringify(body));
  }

  function reject(req, res, status) {
    req.resume(); send(res, status, denied(status)); return true;
  }

  function track(req, res, kind, actor) {
    const record = { req, res, kind, actor, epoch, finished: false, accepted: false, cleanup: () => {} };
    const counters = totals;
    active.add(record);
    const finish = (aborted) => {
      if (record.finished) return;
      record.finished = true;
      if (record.accepted) {
        const key = aborted ? "aborted" : "completed";
        counters[key] = count(counters[key]);
      }
      active.delete(record); pending.delete(record.id); record.cleanup();
      req.off("aborted", onAbort); req.off("error", onAbort);
      res.off("finish", onFinish); res.off("close", onClose); res.off("error", onAbort);
    };
    const onAbort = () => finish(true);
    const onFinish = () => finish(false);
    const onClose = () => finish(!res.writableFinished);
    Object.assign(record, { finish });
    req.once("aborted", onAbort); req.once("error", onAbort);
    res.once("finish", onFinish); res.once("close", onClose); res.once("error", onAbort);
    return record;
  }

  const current = (record) => !closed && record.epoch === epoch && !record.finished
    && !record.req.aborted && !record.res.destroyed && !record.res.writableEnded;

  function readJson(record, dispatch) {
    const { req, res } = record;
    let size = 0;
    const chunks = [];
    const onData = (chunk) => {
      if (!current(record)) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        record.cleanup(); req.resume(); send(res, 413, denied(413));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      if (!current(record)) return;
      let body;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
      } catch { record.cleanup(); send(res, 400, denied(400)); return; }
      record.cleanup();
      if (current(record)) dispatch(body);
    };
    record.cleanup = () => { chunks.length = 0; req.off("data", onData); req.off("end", onEnd); };
    req.on("data", onData); req.once("end", onEnd);
  }

  function destroyActive(except) {
    for (const record of [...active]) {
      if (record === except) continue;
      record.finish(true); record.res.destroy(); record.req.destroy();
    }
    pending.clear();
  }

  function reset(except) {
    epoch++; destroyActive(except); reports.close(); reports = createAdvertisingReportsHttpFixture();
    videos = { A: seed("A"), B: seed("B") }; mode = "success"; received = [];
    totals = { received: 0, completed: 0, aborted: 0, statusWrites: 0 };
  }

  function delivery(record, body) {
    const test = isDeepStrictEqual(body, { test: true });
    if (!test && !isDeepStrictEqual(body, videos[record.actor])) { send(record.res, 400, denied(400)); return; }
    record.accepted = true;
    Object.assign(record, { id: `telegram-delivery-${++sequence}`, test });
    totals.received = count(totals.received);
    received.push({ id: record.id, actor: record.actor, test });
    if (received.length > MAX_JOURNAL) received.shift();
    if (mode === "partial") {
      send(record.res, 502, { success: false, error: "TEST ONLY: synthetic Telegram partial delivery",
        details: ["Part 2/3: synthetic rate limit; no provider was contacted"],
        telegramDescription: "TEST ONLY: synthetic rate limit", telegramErrorCode: 429, status: 429, part: 2, totalParts: 3,
        hint: "TEST ONLY: partial delivery; check before retrying. No external calls were made." });
      return;
    }
    const text = JSON.stringify({ success: true, mode: "telegram", data: { sent: true,
      packageText: test ? "TEST ONLY: synthetic Telegram connectivity check" : buildTelegramPackage(body),
      test, parts: test ? 1 : 3 } });
    const headers = { ...HEADERS, "Content-Length": Buffer.byteLength(text) };
    if (mode === "success") { record.res.writeHead(200, headers); record.res.end(text); return; }
    record.phase = mode === "hold-headers" ? "headers" : "body";
    record.release = () => {
      if (!current(record)) return;
      pending.delete(record.id);
      if (record.phase === "headers") { record.res.writeHead(200, headers); record.res.end(text); }
      else record.res.end(text.slice(1));
    };
    pending.set(record.id, record);
    if (record.phase === "body") { record.res.writeHead(200, headers); record.res.write(text[0]); record.res.flushHeaders(); }
  }

  function command(record, body) {
    if (!object(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "action")
      || ![...MODES, "release", "reset", "edit-A"].includes(body.action)) { send(record.res, 400, denied(400)); return; }
    if (body.action === "reset") reset(record);
    else if (body.action === "release") {
      // Release all captured replies; changing mode never rewrites an older response.
      for (const held of [...pending.values()]) held.release();
    } else if (body.action === "edit-A") {
      if (![...pending.values()].some((held) => held.actor === "A" && !held.test && current(held))) {
        send(record.res, 400, denied(400)); return;
      }
      videos.A = { ...videos.A, caption: "QA A caption edited while delivery was held", updatedAt: nextVersion(videos.A) };
    } else mode = body.action;
    send(record.res, 200, snapshot());
  }

  function handle(req, res) {
    const raw = req.url;
    if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || /[\\#\s]/.test(raw)) return reject(req, res, 400);
    let url;
    try { url = new URL(raw, "http://127.0.0.1"); } catch { return reject(req, res, 400); }
    const rawPath = raw.split("?", 1)[0];
    let decoded;
    try { decoded = decodeURIComponent(rawPath); } catch { return reject(req, res, 400); }
    const fixturePath = /^\/(?:api|__fixture)(?:\/|$)/;
    if (!fixturePath.test(rawPath) && !fixturePath.test(decoded) && !fixturePath.test(url.pathname)) return false;
    if (closed) return reject(req, res, 503);
    if (!loopbackOrigin(req) || rawPath !== url.pathname || decoded !== rawPath) return reject(req, res, 400);
    if (![CONTROL, VIDEOS, SEND].includes(rawPath) && !READS.has(rawPath)) return reject(req, res, 403);
    if (rawPath === CONTROL) {
      if (raw !== CONTROL) return reject(req, res, 400);
      if (req.method === "GET") { req.resume(); send(res, 200, snapshot()); return true; }
      if (req.method !== "POST") return reject(req, res, 403);
    } else {
      const actor = req.headers.authorization === "Bearer fixture-ads-A" ? "A"
        : req.headers.authorization === "Bearer fixture-ads-B" ? "B" : null;
      if (!actor) return reject(req, res, 401);
      if (url.search !== `?workspaceId=${W1}` || raw !== `${rawPath}${url.search}`) return reject(req, res, 403);
      if (READS.has(rawPath)) {
        if (req.method !== "GET") return reject(req, res, 403);
        return reports.handle(req, res);
      }
      if (rawPath === VIDEOS && req.method === "GET") { req.resume(); send(res, 200, ok({ videos: [videos[actor]] })); return true; }
      if (rawPath === VIDEOS ? req.method !== "PATCH" : req.method !== "POST") return reject(req, res, 403);
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")
      || req.headers["content-encoding"] !== undefined) return reject(req, res, 400);
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return reject(req, res, 413);
    const kind = rawPath === CONTROL ? "control" : rawPath === SEND ? "delivery" : "patch";
    if ([...active].filter((entry) => (entry.kind === "control") === (kind === "control")).length
      >= (kind === "control" ? MAX_CONTROLS : MAX_ACTIVE)) return reject(req, res, 503);
    const actor = req.headers.authorization === "Bearer fixture-ads-A" ? "A" : "B";
    const record = track(req, res, kind, actor);
    readJson(record, (body) => {
      if (kind === "control") command(record, body);
      else if (kind === "delivery") delivery(record, body);
      else if (!object(body) || typeof body.expectedUpdatedAt !== "string" || !body.expectedUpdatedAt
        || !isDeepStrictEqual(body, { id: videos[actor].id, status: "telegram_ready", expectedUpdatedAt: body.expectedUpdatedAt })) {
        send(res, 400, denied(400));
      } else if (body.expectedUpdatedAt !== videos[actor].updatedAt) {
        send(res, 409, { ...denied(409), code: "content_version_conflict" });
      } else {
        videos[actor] = { ...videos[actor], status: "telegram_ready", updatedAt: nextVersion(videos[actor]) };
        totals.statusWrites = count(totals.statusWrites);
        send(res, 200, ok({ video: videos[actor] }));
      }
    });
    return true;
  }

  function close() {
    if (closed) return;
    closed = true; epoch++; destroyActive(); reports.close();
  }
  return { handle, snapshot, close };
}
