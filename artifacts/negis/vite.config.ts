import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
// Статически, а не через await import: загрузчик конфига Vite перехватывает
// динамические импорты внутри плагина и падает на них.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import type { IncomingMessage, ServerResponse } from "node:http";

const rawPort = process.env.PORT ?? "5173";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";
const repoRoot = path.resolve(import.meta.dirname, "..", "..");

type DevApiRequest = IncomingMessage & {
  body?: unknown;
  query: Record<string, string | string[] | undefined>;
};

type DevApiResponse = ServerResponse & {
  status: (statusCode: number) => DevApiResponse;
  json: (body: unknown) => void;
};

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const contentType = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"] || "";
  if (!contentType.includes("application/json")) return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return undefined;

  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!rawBody.trim()) return undefined;

  return JSON.parse(rawBody);
}

function createDevApiResponse(res: ServerResponse): DevApiResponse {
  const devRes = res as DevApiResponse;

  devRes.status = (statusCode: number) => {
    res.statusCode = statusCode;
    return devRes;
  };

  devRes.json = (body: unknown) => {
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify(body));
  };

  return devRes;
}

function buildQuery(url: URL): Record<string, string | string[] | undefined> {
  const query: Record<string, string | string[] | undefined> = {};

  url.searchParams.forEach((value, key) => {
    const current = query[key];
    if (Array.isArray(current)) {
      current.push(value);
    } else if (typeof current === "string") {
      query[key] = [current, value];
    } else {
      query[key] = value;
    }
  });

  return query;
}

function targetingApiDevMiddleware(): Plugin {
  const apiModule = (...segments: string[]) =>
    `/@fs/${path.resolve(repoRoot, ...segments).replace(/\\/g, "/")}`;

  return {
    name: "negis-targeting-api-dev-middleware",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? "/", "http://localhost");
        const pathname = requestUrl.pathname;

        if (
          !pathname.startsWith("/api/targeting") &&
          !pathname.startsWith("/api/content-studio") &&
          !pathname.startsWith("/api/crm") &&
          pathname !== "/api/auth/register" &&
          pathname !== "/api/webhooks/wazzup" &&
          pathname !== "/api/webhooks/whatsapp"
        ) {
          next();
          return;
        }

        try {
          const query = buildQuery(requestUrl);
          let modulePath: string | null = null;

          if (pathname === "/api/auth/register") {
            modulePath = apiModule("api", "auth", "register.ts");
          } else if (pathname === "/api/webhooks/wazzup") {
            // Dev parity for the Wazzup inbound webhook: in production the
            // filesystem handler routes the plain file; without this entry the
            // dev server dropped the same request into the SPA fallback and
            // the route could not be exercised locally at all.
            modulePath = apiModule("api", "webhooks", "wazzup.ts");
          } else if (pathname === "/api/webhooks/whatsapp") {
            // Same parity for the WhatsApp Cloud API webhook. The middleware
            // has already consumed the stream, so the entry point falls back
            // to the parsed body — enough for the unauthenticated boundary,
            // which is all dev exercises.
            modulePath = apiModule("api", "webhooks", "whatsapp.ts");
          } else if (pathname.startsWith("/api/content-studio/")) {
            const contentPath = pathname.replace(/^\/api\/content-studio\//, "").split("/").filter(Boolean);
            modulePath = apiModule("api", "content-studio", "[...path].ts");
            query.path = contentPath;
          } else if (pathname.startsWith("/api/crm/")) {
            const crmPath = pathname.replace(/^\/api\/crm\//, "").split("/").filter(Boolean);
            modulePath = apiModule("api", "crm", "[...path].ts");
            query.path = crmPath;
          } else if (pathname === "/api/targeting/health") {
            modulePath = apiModule("api", "targeting", "health.ts");
          } else if (pathname === "/api/targeting/analyze") {
            modulePath = apiModule("api", "targeting", "analyze.ts");
          } else if (pathname === "/api/targeting/launch") {
            modulePath = apiModule("api", "targeting", "launch.ts");
          } else if (pathname === "/api/targeting/report") {
            modulePath = apiModule("api", "targeting", "report.ts");
          } else {
            const reportMatch = pathname.match(/^\/api\/targeting\/reports\/([^/]+)$/);
            if (reportMatch?.[1]) {
              modulePath = apiModule("api", "targeting", "reports", "[campaignId].ts");
              query.campaignId = decodeURIComponent(reportMatch[1]);
            }
          }

          if (!modulePath) {
            next();
            return;
          }

          const loaded = (await server.ssrLoadModule(modulePath)) as {
            default: (req: DevApiRequest, res: DevApiResponse) => Promise<void> | void;
          };

          const devReq = Object.assign(req, {
            body: await readJsonBody(req),
            query,
          }) as DevApiRequest;

          await loaded.default(devReq, createDevApiResponse(res));
        } catch (error) {
          server.ssrFixStacktrace(error as Error);
          next(error);
        }
      });
    },
  };
}

/**
 * Штампует в service worker отпечаток сборки.
 *
 * Браузер решает, что вышла новая версия, по одному признаку: файл sw.js стал
 * другим. Пока в нём стоит постоянная строка, деплой проходит незамеченным, и
 * установленное приложение продолжает открывать старую сборку — то есть
 * «обновляется само» перестаёт быть правдой.
 *
 * Отпечаток берётся от ИМЁН собранных файлов, а не от времени: имена содержат
 * хэш содержимого, поэтому сборка без изменений даёт тот же отпечаток и лишнего
 * обновления не будет.
 */
function stampServiceWorker(): Plugin {
  return {
    name: "negis-service-worker-build-id",
    apply: "build",
    async closeBundle() {
      const outDir = path.resolve(import.meta.dirname, "dist/public");
      const swPath = path.join(outDir, "sw.js");

      let source: string;
      try {
        source = await readFile(swPath, "utf8");
      } catch {
        // sw.js кладётся из public; если его нет — молчать нельзя, иначе
        // приложение останется без обновлений и никто об этом не узнает.
        this.error("sw.js не найден в сборке: обновления работать не будут");
        return;
      }

      const assets = await readdir(path.join(outDir, "assets")).catch(() => [] as string[]);
      const buildId = createHash("sha256").update(assets.sort().join("|")).digest("hex").slice(0, 12);
      await writeFile(swPath, source.replace("__BUILD_ID__", buildId), "utf8");
    },
  };
}

export default defineConfig(async () => ({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    targetingApiDevMiddleware(),
    stampServiceWorker(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Routes are already split via React.lazy in App.tsx. This splits the
        // remaining vendor code so the entry chunk is not one monolith that
        // every visitor — including the public landing — has to download.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
          if (id.includes("@supabase")) return "vendor-supabase";
          if (id.includes("recharts") || id.includes("d3-")) return "vendor-charts";
          if (id.includes("react-hook-form") || id.includes("zod") || id.includes("@hookform")) return "vendor-forms";
          return "vendor";
        },
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      allow: [repoRoot],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
}));
