import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

// No app config, API middleware, credentials or database. Only an injected in-memory request fixture.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis");
const require = createRequire(path.join(frontend, "package.json"));
for (const key of Object.keys(process.env)) {
  if (!["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"].includes(key)) delete process.env[key];
}
globalThis.fetch = async () => { throw new Error("External fetch forbidden in fixture"); };
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);
const { default: react } = await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href);
const { default: tailwindcss } = await import(pathToFileURL(require.resolve("@tailwindcss/vite")).href);
const entry = `/@fs/${path.join(root, "scripts/fixtures/site-deletion-browser.tsx").replaceAll("\\", "/")}`;
const server = await createServer({
  configFile: false, root: frontend, envDir: path.join(root, "scripts/fixtures"),
  cacheDir: path.join(tmpdir(), "medina-site-deletion-vite"),
  optimizeDeps: { entries: [path.join(root, "scripts/fixtures/site-deletion-browser.tsx")] },
  resolve: { dedupe: ["react", "react-dom"], alias: { react: path.dirname(require.resolve("react/package.json")), "react-dom": path.dirname(require.resolve("react-dom/package.json")) } },
  plugins: [react(), tailwindcss(), { name: "isolated-site-deletion", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith("/api/")) { res.statusCode = 403; res.end("API disabled in fixture"); return; }
      if (req.url !== "/") return next();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:5179; img-src 'self' data:");
      res.end(await server.transformIndexHtml("/", `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Medina OS · локальная фикстура</title></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
    });
  } }],
  server: { host: "127.0.0.1", port: 5179, strictPort: true, fs: { allow: [root] } },
});
await server.listen();
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await server.close(); process.exit(0); });
