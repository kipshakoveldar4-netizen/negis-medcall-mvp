import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createGeneratedVideoBrowserHttpFixture, generatedVideoFixtureIds, generatedVideoFixturePaths, generatedVideoFixtureStates } from "./generated-video-browser-http-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis"), require = createRequire(path.join(frontend, "package.json"));
export async function createGeneratedVideoBrowser(port = 0) {
if (!Number.isInteger(port) || port < 0 || port > 65535 || (port > 0 && port < 1024)) throw Error("Invalid local port");
if (Object.keys(process.env).some(key => /^VITE_/i.test(key))) {
  throw Error("Inherited browser bindings are forbidden in this synthetic fixture");
}
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const { default: react } = await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href);
const { default: tailwindcss } = await import(pathToFileURL(require.resolve("@tailwindcss/vite")).href);
const entry = path.join(root, "scripts/fixtures/generated-video-browser.tsx");
const mocks = path.join(root, "scripts/fixtures/advertising-reports-browser-mocks.tsx");
// Existing owned synthetic MP4, never a customer upload or a provider output.
const video = await readFile(path.join(root, "node_modules/.cache/photo-delivery-20261023/synthetic-C32.mp4"));
if (video.length !== 126111 || createHash("sha256").update(video).digest("hex") !== "933bfb41a794631140a4aa16e04d113ef1fa1527c13ade9684e35e8ee828b6cf") {
  throw Error("The existing owned synthetic clip is missing or changed; no download or customer-file fallback");
}
const thumbnail = Buffer.from("/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJUAB//Z", "base64");
const fixture = createGeneratedVideoBrowserHttpFixture({ video, thumbnail });
let origin;
const mediaRequests = [];
const mediaRoot = "/storage/v1/object/public/ad-creatives/";
const worker = `self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{const u=new URL(event.request.url);
 if(u.origin===self.location.origin)return;
 const paths=${JSON.stringify({ [mediaRoot + generatedVideoFixturePaths.video]: "/__fixture/synthetic.mp4", [mediaRoot + generatedVideoFixturePaths.thumbnail]: "/__fixture/thumbnail.jpg" })};
 if(u.origin!==${JSON.stringify(generatedVideoFixtureIds.storageOrigin)}||u.search||u.hash||!paths[u.pathname]||!['GET','HEAD'].includes(event.request.method)){
  event.respondWith(Promise.resolve(new Response('External request forbidden',{status:403})));return;}
 const headers=new Headers();const range=event.request.headers.get('range');if(range)headers.set('Range',range);
 event.respondWith(fetch(paths[u.pathname],{method:event.request.method,headers,credentials:'omit',cache:'no-store'}));});`;
const server = await createServer({ configFile: false, root: frontend, envDir: false, appType: "custom",
  cacheDir: path.join(tmpdir(), `medina-generated-video-${process.pid}-${port}`), optimizeDeps: { entries: [entry] },
  define: { "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(generatedVideoFixtureIds.storageOrigin) },
  resolve: { dedupe: ["react", "react-dom"], alias: [
    { find: "@/contexts/AuthContext", replacement: mocks }, { find: "@/lib/supabase", replacement: mocks },
    { find: "@/components/layout/PageLayout", replacement: mocks }, { find: "@", replacement: path.join(frontend, "src") },
    ...["wouter", "sonner", "react", "react-dom"].map(name => ({ find: new RegExp(`^${name}$`), replacement: require.resolve(name) })),
    ...["react", "react-dom"].map(name => ({ find: new RegExp(`^${name}/`), replacement: `${path.dirname(require.resolve(`${name}/package.json`))}/` })),
  ] }, plugins: [react(), tailwindcss(), { name: "isolated-generated-video", configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (!origin || req.headers.host !== new URL(origin).host) { res.writeHead(403); res.end(); return; }
    if (fixture.handle(req, res)) return;
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/__fixture/generated-video-sw.js" && req.method === "GET" && !url.search) {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store", "Service-Worker-Allowed": "/content-studio" });
      res.end(worker); return;
    }
    if (["/__fixture/synthetic.mp4", "/__fixture/thumbnail.jpg"].includes(url.pathname) && ["GET", "HEAD"].includes(req.method) && !url.search) {
      mediaRequests.push({ path: url.pathname, method: req.method });
      const bytes = url.pathname.endsWith(".mp4") ? video : thumbnail;
      let start = 0, end = bytes.length - 1, status = 200;
      if (req.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!range || !Number.isSafeInteger(Number(range[1])) || Number(range[1]) >= bytes.length
          || (range[2] && Number(range[2]) < Number(range[1]))) { res.writeHead(416); res.end(); return; }
        start = Number(range[1]); end = range[2] ? Math.min(end, Number(range[2])) : end; status = 206;
      }
      res.writeHead(status, { "Content-Type": url.pathname.endsWith(".mp4") ? "video/mp4" : "image/jpeg", "Content-Length": end - start + 1,
        "Cache-Control": "no-store", "Accept-Ranges": "bytes", ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}) });
      res.end(req.method === "HEAD" ? undefined : bytes.subarray(start, end + 1)); return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__fixture/")) { res.writeHead(403); res.end(); return; }
    if (url.pathname !== "/content-studio") {
      if (req.headers["sec-fetch-dest"] === "document" || req.headers.accept?.includes("text/html")) { res.writeHead(404); res.end(); return; }
      return next();
    }
    if (req.method !== "GET" || [...url.searchParams].length !== 1 || !generatedVideoFixtureStates.includes(url.searchParams.get("video"))) { res.writeHead(403); res.end(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data: blob: ${generatedVideoFixtureIds.storageOrigin}; media-src 'self' ${generatedVideoFixtureIds.storageOrigin}; font-src 'self'; form-action 'none'; frame-src 'none'`);
    res.end(await vite.transformIndexHtml(url.pathname, `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Medina OS generated video test</title></head><body><div id="root"></div><script type="module" src="/@fs/${entry.replaceAll("\\", "/")}"></script></body></html>`));
  }); } }], server: { host: "127.0.0.1", port, strictPort: port !== 0, cors: false, fs: { allow: [root] } } });
await server.listen();
origin = `http://127.0.0.1:${server.httpServer.address().port}`;
return { origin, snapshot: fixture.snapshot, mediaRequests, close: async () => { fixture.close(); await server.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
for (const key of Object.keys(process.env)) if (!["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"].includes(key)) delete process.env[key];
globalThis.fetch = async () => { throw Error("External fetch forbidden in generated video fixture"); };
const port = Number(process.argv.find(value => value.startsWith("--port="))?.slice(7) || 5248);
const fixture = await createGeneratedVideoBrowser(port);
console.log(`LOCAL ONLY: ${fixture.origin}/content-studio?video=validation`);
console.log("Other isolated states: video=generation, video=ready, video=failed, video=invalid, video=held");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
