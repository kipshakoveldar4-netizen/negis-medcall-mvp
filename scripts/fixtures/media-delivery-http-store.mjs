import { createAdvertisingReportsHttpFixture } from "./advertising-reports-http-store.mjs";

const workspace = "aaaaaaaa-1111-4111-8111-111111111111";
const handles = new Set(["synthetic-local-video-handle"]);
const controlPath = "/__fixture/media-delivery";
const videoPath = "/api/content-studio/video-generation";
const telegramPath = "/api/content-studio/send-telegram";
const actions = new Set(["completed", "missing", "broken", "held", "available", "release", "telegram-off", "telegram-partial", "reset"]);

export function createMediaDeliveryHttpFixture() {
  const reports = createAdvertisingReportsHttpFixture();
  let mode = "completed", telegram = "off", closed = false, videoCompleted = 0, videoAborted = 0, epoch = 0;
  const pending = new Set();
  const events = [];
  const snapshot = () => ({ mode, telegram, pending: pending.size, videoCompleted, videoAborted, externalCalls: 0, events: [...events], closed });
  function send(res, status, body) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(body));
  }
  function validOrigin(req) {
    const host = req.headers.host;
    if (typeof host !== "string" || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)
      || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) return false;
    return req.headers.origin === undefined || req.headers.origin === `http://${host}`;
  }
  function release() {
    for (const res of pending) sendVideo(res);
    pending.clear();
  }
  function sendVideo(res) {
    send(res, 200, { success: true, mode: "synthetic", data: {
      status: "completed", progress: 100,
      ...(mode === "missing" ? {} : { creativeUrl: "/__fixture/synthetic.mp4", fileName: "synthetic.mp4", mimeType: "video/mp4", fileSize: 0 }),
    } });
  }
  async function read(req) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || "") || req.headers["content-encoding"]) throw Error("body");
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 20000) throw Error("size"); chunks.push(chunk); }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  }
  function handle(req, res) {
    let url;
    const raw = req.url || "/";
    try {
      url = new URL(raw, "http://127.0.0.1");
      if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("#") || raw.split("?", 1)[0] !== url.pathname) throw Error("Noncanonical path");
    } catch { req.resume(); send(res, 403, { success: false }); return true; }
    if (![controlPath, videoPath, telegramPath].includes(url.pathname)) return reports.handle(req, res);
    if (!validOrigin(req) || closed) { req.resume(); send(res, 403, { success: false }); return true; }
    if (url.pathname === controlPath) {
      if (url.search) { req.resume(); send(res, 400, { success: false }); return true; }
      if (req.method === "GET") { send(res, 200, snapshot()); return true; }
      if (req.method !== "POST") { req.resume(); send(res, 403, { success: false }); return true; }
      const started = epoch;
      void read(req).then(body => {
        if (closed || started !== epoch || req.aborted || res.destroyed) { send(res, 403, { success: false }); return; }
        if (!body || Object.keys(body).length !== 1 || !actions.has(body.action)) throw Error("action");
        const action = body.action;
        if (action === "reset") {
          epoch++;
          for (const response of pending) response.destroy();
          pending.clear(); mode = "completed"; telegram = "off"; events.length = 0; videoCompleted = videoAborted = 0;
        } else if (action === "release") release();
        else if (action === "available") mode = "completed";
        else if (action.startsWith("telegram-")) telegram = action.slice(9);
        else mode = action;
        send(res, 200, snapshot());
      }).catch(() => send(res, 400, { success: false }));
      return true;
    }
    const actor = req.headers.authorization === "Bearer fixture-ads-A" ? "A" : req.headers.authorization === "Bearer fixture-ads-B" ? "B" : null;
    if (!actor || url.searchParams.getAll("workspaceId").length !== 1 || url.searchParams.get("workspaceId") !== workspace) {
      req.resume(); send(res, 403, { success: false }); return true;
    }
    if (events.length >= 100) { req.resume(); send(res, 429, { success: false }); return true; }
    if (url.pathname === videoPath) {
      if (actor !== "A") { req.resume(); send(res, 403, { success: false, error: "Synthetic actor has no video access" }); return true; }
      if (req.method !== "GET" || [...url.searchParams].length !== 2 || !handles.has(url.searchParams.get("handle"))) {
        req.resume(); send(res, 403, { success: false }); return true;
      }
      events.push({ resource: "video", actor, mode });
      const started = epoch;
      let finished = false;
      res.once("finish", () => { finished = true; if (started === epoch) videoCompleted++; });
      res.once("close", () => { if (!finished && started === epoch) videoAborted++; });
      if (mode === "held") { pending.add(res); res.once("close", () => pending.delete(res)); }
      else sendVideo(res);
    } else {
      if (req.method !== "POST" || [...url.searchParams].length !== 1) { req.resume(); send(res, 403, { success: false }); return true; }
      const started = epoch;
      void read(req).then(body => {
        if (closed || started !== epoch || req.aborted || res.destroyed) { send(res, 403, { success: false }); return; }
        if (!body || body.test !== true || Object.keys(body).length !== 1) throw Error("Only fabricated connection checks allowed");
        if (events.length >= 100) { send(res, 429, { success: false }); return; }
        events.push({ resource: "telegram", actor, mode: telegram });
        if (telegram === "partial") send(res, 502, { success: false, error: "Synthetic partial delivery", details: ["Part 2/3: synthetic refusal"], status: 429, part: 2, totalParts: 3 });
        else send(res, 200, { success: true, mode: "demo", warning: "ТЕСТ: Telegram не подключён, сообщение не отправлялось.", data: { sent: false, test: true, packageText: "TEST synthetic connection" } });
      }).catch(() => send(res, 400, { success: false }));
    }
    return true;
  }
  return { handle, snapshot, close() { closed = true; for (const res of pending) res.destroy(); pending.clear(); reports.close(); } };
}
