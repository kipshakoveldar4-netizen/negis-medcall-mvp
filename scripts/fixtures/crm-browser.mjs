import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

// A visual fixture, not an authentication or persistence test. No application
// config/env is loaded; every data request is replaced by synthetic responses.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis");
const require = createRequire(path.join(frontend, "package.json"));
for (const key of Object.keys(process.env)) {
  if (!["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"].includes(key)) delete process.env[key];
}
globalThis.fetch = async () => { throw new Error("External fetch forbidden in CRM fixture"); };
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const { default: react } = await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href);
const { default: tailwindcss } = await import(pathToFileURL(require.resolve("@tailwindcss/vite")).href);
const entryPath = path.join(root, "scripts/fixtures/crm-browser.tsx");
const mocks = path.join(root, "scripts/fixtures/crm-browser-mocks.ts");
const routes = new Set(["/", "/appointments", "/clients", "/sales", "/leads", "/login", "/dashboard", "/tasks", "/analytics", "/admin", "/operator", "/clinic-arrival", "/content-studio", "/ads-automation", "/ads", "/privacy", "/terms", "/data-deletion"]);
const requestedPort=Number(process.argv.find(arg=>arg.startsWith('--port='))?.split('=')[1]||5181);
if(!Number.isInteger(requestedPort)||requestedPort<1024||requestedPort>65535)throw new Error('Invalid local fixture port');
const server = await createServer({
  configFile: false, root: frontend, envDir: false, appType: "custom",
  cacheDir: path.join(tmpdir(), `medina-crm-browser-vite-${requestedPort}`),
  optimizeDeps: { entries: [entryPath] },
  resolve: { dedupe: ["react", "react-dom"], alias: [
    { find: "@/contexts/AuthContext", replacement: mocks },
    { find: "@/lib/api", replacement: mocks },
    { find: "@/lib/supabase", replacement: mocks },
    { find: "@", replacement: path.join(frontend, "src") },
    { find: "wouter", replacement: require.resolve("wouter") },
    { find: "sonner", replacement: require.resolve("sonner") },
    { find: /^react$/, replacement: require.resolve("react") },
    { find: /^react\//, replacement: path.dirname(require.resolve("react/package.json")) + "/" },
    { find: /^react-dom$/, replacement: require.resolve("react-dom") },
    { find: /^react-dom\//, replacement: path.dirname(require.resolve("react-dom/package.json")) + "/" },
  ] },
  plugins: [react(), tailwindcss(), { name: "isolated-crm-browser", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (pathname.startsWith("/api/")) { res.statusCode = 403; res.end("API disabled in fixture"); return; }
      if (pathname === "/ads" && (req.url !== "/ads?advertising=demo" || req.socket?.encrypted
        || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers.host || ""))) {
        res.statusCode = 403;
        res.end("Advertising demo requires exact HTTP loopback opt-in");
        return;
      }
      if (pathname === "/clinic-arrival" && !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers.host || "")) {
        res.statusCode = 403;
        res.end("Clinic arrival fixture is loopback-only");
        return;
      }
      if (["/content-studio", "/ads-automation"].includes(pathname)
        && !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers.host || "")) {
        res.statusCode = 403;
        res.end("Content studio fixture is loopback-only");
        return;
      }
      if (!routes.has(pathname)) {
        if (req.headers["sec-fetch-dest"] === "document" || req.headers.accept?.includes("text/html")) {
          res.statusCode = 404;
          res.end("Route not included in isolated CRM fixture");
          return;
        }
        return next();
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; font-src 'self'; form-action 'none'; frame-src 'none'");
      res.end(await vite.transformIndexHtml(pathname, `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Medina OS · тестовая CRM</title></head><body><div id="root"></div><script type="module" src="/@fs/${entryPath.replaceAll("\\", "/")}"></script></body></html>`));
    });
  } }],
  server: { host: "127.0.0.1", port: requestedPort, strictPort: true, fs: { allow: [root] } },
});
await server.listen();
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await server.close(); process.exit(0); });
