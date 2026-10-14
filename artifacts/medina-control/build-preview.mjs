import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveControlPreviewTarget } from "./preview-target.mjs";

const target = resolveControlPreviewTarget(process.env);
if (!target) {
  console.info("Medina Control: isolated Preview build skipped.");
} else {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const { build } = await import("vite");
  await build({
    configFile: path.join(root, "vite.config.ts"),
    base: "/medina-control/",
  });
  const output = path.join(root, "../negis/dist/public/medina-control");
  await mkdir(output, { recursive: true });
  await cp(path.join(root, "dist"), output, {
    recursive: true,
    force: true,
  });
  console.info("Medina Control: isolated same-origin Preview assets prepared.");
}
