import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import {
  resolveControlBrowserEnv,
  resolveControlConfig,
} from "./src/lib/control-config";
import { resolveControlPreviewTarget } from "./preview-target.mjs";

// Medina Control — портал владельца платформы.
//
// Нарочно минимальный конфиг: это статический сайт без своих serverless-функций.
// Все данные приезжают из существующего API по адресу из VITE_MEDINA_API_URL,
// поэтому здесь нет ни dev-middleware, ни service worker: порталом пользуется
// один человек с ноутбука, обновления браузер берёт обычным способом.

export default defineConfig(({ command, mode }) => {
  const root = path.resolve(import.meta.dirname);
  const preview = resolveControlPreviewTarget(process.env);
  const env = loadEnv(mode, root, "");
  const configuredEnv = preview
    ? {
        ...env,
        VITE_MEDINA_CONTROL_MODE: "isolated-preview",
        VITE_MEDINA_API_URL: preview.apiOrigin,
        VITE_SUPABASE_URL: preview.supabaseUrl,
      }
    : env;
  const config = resolveControlConfig(configuredEnv, command === "serve");
  if (preview && !config.ready)
    throw new Error("Isolated Control Preview configuration is invalid.");
  // Serialize only validated public configuration, never arbitrary VITE_* values.
  const browserEnv = resolveControlBrowserEnv(
    configuredEnv,
    command === "serve",
  );
  return {
    plugins: [react()],
    root,
    envPrefix: [],
    define: Object.fromEntries(
      Object.entries(browserEnv).map(([key, value]) => [
        `import.meta.env.${key}`,
        JSON.stringify(value),
      ]),
    ),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist"),
      emptyOutDir: true,
    },
    server: {
      // Не 5173: CRM и портал должны подниматься рядом, не мешая друг другу.
      port: Number(process.env.PORT ?? "5174"),
      strictPort: true,
      host: "0.0.0.0",
    },
  };
});
