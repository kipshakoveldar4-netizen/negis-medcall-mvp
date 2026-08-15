import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Medina Control — портал владельца платформы.
//
// Нарочно минимальный конфиг: это статический сайт без своих serverless-функций.
// Все данные приезжают из существующего API по адресу из VITE_MEDINA_API_URL,
// поэтому здесь нет ни dev-middleware, ни service worker: порталом пользуется
// один человек с ноутбука, обновления браузер берёт обычным способом.

export default defineConfig({
  plugins: [react()],
  root: path.resolve(import.meta.dirname),
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
});
