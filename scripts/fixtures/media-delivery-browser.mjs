import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createMediaDeliveryHttpFixture } from "./media-delivery-http-store.mjs";
import { createTelegramDeliveryHttpFixture } from "./telegram-delivery-http-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis"), require = createRequire(path.join(frontend, "package.json"));
for (const key of Object.keys(process.env)) if (!["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"].includes(key)) delete process.env[key];
globalThis.fetch = async () => { throw Error("External fetch forbidden in media fixture"); };
const port = Number(process.argv.find(a => a.startsWith("--port="))?.split("=")[1] || 5238);
const telegramOnly = process.argv.includes("--telegram");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid fixture port");
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const { default: react } = await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href);
const { default: tailwindcss } = await import(pathToFileURL(require.resolve("@tailwindcss/vite")).href);
const entry = path.join(root, telegramOnly ? "scripts/fixtures/telegram-delivery-browser.tsx" : "scripts/fixtures/media-delivery-browser.tsx");
const mocks = path.join(root, "scripts/fixtures/advertising-reports-browser-mocks.tsx");
const video = telegramOnly ? null : await readFile(path.join(root, "node_modules/.cache/photo-delivery-20261023/synthetic-C32.mp4"));
const fixture = telegramOnly ? createTelegramDeliveryHttpFixture() : createMediaDeliveryHttpFixture();
const server = await createServer({ configFile: false, root: frontend, envDir: false, appType: "custom",
  cacheDir: path.join(tmpdir(), `medina-media-delivery-${port}`), optimizeDeps: { entries: [entry] },
  resolve: { dedupe: ["react", "react-dom"], alias: [
    { find: "@/contexts/AuthContext", replacement: mocks }, { find: "@/lib/supabase", replacement: mocks },
    { find: "@/components/layout/PageLayout", replacement: mocks }, { find: "@", replacement: path.join(frontend, "src") },
    ...["wouter", "sonner", "react", "react-dom"].map(name => ({ find: new RegExp("^" + name + "$"), replacement: require.resolve(name) })),
    ...["react", "react-dom"].map(name => ({ find: new RegExp("^" + name + "/"), replacement: path.dirname(require.resolve(name + "/package.json")) + "/" })),
  ] }, plugins: [react(), tailwindcss(), { name: "isolated-media-delivery", configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host || "")) { res.statusCode = 403; res.end(); return; }
    if (fixture.handle(req, res)) return;
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (video && url.pathname === "/__fixture/synthetic.mp4" && req.method === "GET" && !url.search) {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": video.length, "Cache-Control": "no-store" }); res.end(video); return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__fixture/")) { res.statusCode = 403; res.end(); return; }
    if (url.pathname !== "/content-studio") {
      if (req.headers["sec-fetch-dest"] === "document" || req.headers.accept?.includes("text/html")) { res.statusCode = 404; res.end(); return; }
      return next();
    }
    if (url.search !== (telegramOnly ? "?telegram=delivery" : "?media=delivery") || req.socket?.encrypted) { res.statusCode = 403; res.end(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data: blob:; media-src 'self'; font-src 'self'; form-action 'none'; frame-src 'none'");
    res.end(await vite.transformIndexHtml(url.pathname, `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Medina OS media test</title></head><body><div id="root"></div><script type="module" src="/@fs/${entry.replaceAll("\\", "/")}"></script></body></html>`));
  }); } }], server: { host: "127.0.0.1", port, strictPort: true, cors: false, fs: { allow: [root] } } });
await server.listen(); server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { fixture.close(); await server.close(); process.exit(0); });
