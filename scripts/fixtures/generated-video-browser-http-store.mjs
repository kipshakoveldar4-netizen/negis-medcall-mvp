import { createHash } from "node:crypto";
import { createAdvertisingReportsHttpFixture } from "./advertising-reports-http-store.mjs";

export const generatedVideoFixtureIds = Object.freeze({
  actor: "11111111-1111-4111-8111-111111111111", workspace: "aaaaaaaa-1111-4111-8111-111111111111",
  asset: "cccccccc-3333-5333-8333-333333333333", job: "dddddddd-4444-4444-8444-444444444444",
  handle: `g2.synthetic-local-only.${"x".repeat(43)}`, storageOrigin: "https://generated-video.fixture.invalid",
});
export const generatedVideoFixtureStates = ["generation", "validation", "ready", "failed", "invalid", "held"];
const controlPath = "/__fixture/generated-video";
const pollPath = "/api/content-studio/video-generation";
const createPath = "/api/content-studio/generate-video";
const retryPath = `/api/crm/video-processing-jobs/${generatedVideoFixtureIds.job}/retry`;
const fixturePath = `optimized/${generatedVideoFixtureIds.workspace}/${generatedVideoFixtureIds.job}-${"a".repeat(20)}.mp4`;
export const generatedVideoFixturePaths = { video: fixturePath, thumbnail: `${fixturePath.slice(0, -4)}-thumbnail.jpg` };

const local = req => typeof req.headers.host === "string" && /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host)
  && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
  && (req.headers.origin === undefined || req.headers.origin === `http://${req.headers.host}`);
const send = (res, status, body) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
};
async function read(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || "") || req.headers["content-encoding"]) throw Error("body");
  let size = 0; const parts = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8000) throw Error("size"); parts.push(chunk); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
}

export function createGeneratedVideoBrowserHttpFixture({ video, thumbnail }) {
  if (!Buffer.isBuffer(video) || !video.length || !Buffer.isBuffer(thumbnail) || !thumbnail.length) throw Error("Synthetic bytes required");
  const reports = createAdvertisingReportsHttpFixture();
  let state = "validation", retryPosts = 0, generationPosts = 0, polls = 0, epoch = 0, closed = false;
  const pending = new Set(), events = [];
  const snapshot = () => ({ state, retryPosts, generationPosts, polls, pending: pending.size, externalCalls: 0, events: [...events] });
  const receipt = () => ({ nativeValidated: true, assetId: generatedVideoFixtureIds.asset, validationJobId: generatedVideoFixtureIds.job,
    fileName: `negis-video-${"b".repeat(20)}.mp4`, mimeType: "video/mp4", fileSize: video.length,
    sha256: createHash("sha256").update(video).digest("hex"), storageBucket: "ad-creatives", storagePath: fixturePath,
    creativeUrl: `${generatedVideoFixtureIds.storageOrigin}/storage/v1/object/public/ad-creatives/${fixturePath}`,
    thumbnailUrl: `${generatedVideoFixtureIds.storageOrigin}/storage/v1/object/public/ad-creatives/${generatedVideoFixturePaths.thumbnail}`,
    thumbnailPath: generatedVideoFixturePaths.thumbnail, thumbnailSize: thumbnail.length,
    thumbnailSha256: createHash("sha256").update(thumbnail).digest("hex") });
  const data = () => ({ handle: generatedVideoFixtureIds.handle,
    status: state === "ready" || state === "invalid" ? "completed" : state === "failed" ? "failed" : "in_progress",
    phase: state === "generation" ? "generation" : "validation", progress: state === "ready" || state === "invalid" ? 100 : state === "generation" ? 36 : 82,
    ...(state !== "generation" ? { validationJobId: generatedVideoFixtureIds.job } : {}),
    ...(state === "ready" ? receipt() : {}), ...(state === "invalid" ? { creativeUrl: "https://external.invalid/raw.mp4" } : {}) });
  const respondPoll = res => send(res, 200, { success: true, mode: "openai", data: data() });
  const release = () => { for (const res of pending) respondPoll(res); pending.clear(); };
  function handle(req, res) {
    const raw = req.url || "/";
    let url;
    try {
      url = new URL(raw, "http://127.0.0.1");
      if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("#") || raw.split("?", 1)[0] !== url.pathname) throw Error("path");
    } catch { req.resume(); send(res, 403, { success: false }); return true; }
    if (![controlPath, pollPath, createPath, retryPath].includes(url.pathname)) return reports.handle(req, res);
    if (!local(req) || closed) { req.resume(); send(res, 403, { success: false }); return true; }
    if (url.pathname === controlPath) {
      if (url.search) { req.resume(); send(res, 403, { success: false }); return true; }
      if (req.method === "GET") { send(res, 200, snapshot()); return true; }
      if (req.method !== "POST") { req.resume(); send(res, 403, { success: false }); return true; }
      const started = epoch;
      void read(req).then(body => {
        if (started !== epoch || closed || req.aborted || res.destroyed) return;
        if (!body || Object.keys(body).length !== 1 || ![...generatedVideoFixtureStates, "release", "reset"].includes(body.action)) throw Error("action");
        if (body.action === "reset") {
          epoch++; for (const response of pending) response.destroy(); pending.clear(); events.length = 0;
          state = "validation"; retryPosts = generationPosts = polls = 0;
        } else if (body.action === "release") { state = "ready"; release(); }
        else { state = body.action; if (state !== "held") release(); }
        send(res, 200, snapshot());
      }).catch(() => send(res, 400, { success: false }));
      return true;
    }
    if (req.headers.authorization !== "Bearer fixture-ads-A" || url.searchParams.getAll("workspaceId").length !== 1
      || url.searchParams.get("workspaceId") !== generatedVideoFixtureIds.workspace || events.length >= 150) {
      req.resume(); send(res, 403, { success: false, error: "Synthetic video access denied" }); return true;
    }
    if (url.pathname === pollPath) {
      if (req.method !== "GET" || [...url.searchParams].length !== 2 || url.searchParams.get("handle") !== generatedVideoFixtureIds.handle) {
        req.resume(); send(res, 403, { success: false }); return true;
      }
      polls++; events.push({ operation: "poll", state });
      if (state === "held") { pending.add(res); res.once("close", () => pending.delete(res)); } else respondPoll(res);
      return true;
    }
    if (req.method !== "POST" || [...url.searchParams].length !== 1) { req.resume(); send(res, 403, { success: false }); return true; }
    const started = epoch;
    void read(req).then(body => {
      if (started !== epoch || closed || req.aborted || res.destroyed) return;
      if (url.pathname === retryPath) {
        if (state !== "failed" || body?.workspaceId !== generatedVideoFixtureIds.workspace || body?.status !== "failed"
          || Object.keys(body).length !== 2) { send(res, 409, { success: false }); return; }
        retryPosts++; state = "validation"; events.push({ operation: "native-retry" });
        send(res, 200, { success: true, mode: "supabase", data: { job: { id: generatedVideoFixtureIds.job,
          workspaceId: generatedVideoFixtureIds.workspace, status: "queued", progress: 0 } } });
      } else {
        if (typeof body?.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 5000
          || !["reels", "stories", "feed", "universal"].includes(body.format) || Object.keys(body).length !== 2
          || !/^[0-9a-f-]{36}$/.test(req.headers["x-idempotency-key"] || "")) throw Error("fake generation only");
        generationPosts++; events.push({ operation: "fake-generation-only" }); state = "generation";
        send(res, 202, { success: true, mode: "openai", data: { ...data(), formatSubstituted: false } });
      }
    }).catch(() => send(res, 400, { success: false }));
    return true;
  }
  return { handle, snapshot, receipt, close() { closed = true; for (const res of pending) res.destroy(); pending.clear(); reports.close(); } };
}
