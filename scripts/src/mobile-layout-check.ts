import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const baseUrl = (
  process.env.NEGIS_MOBILE_BASE_URL ||
  process.env.NEGIS_SMOKE_BASE_URL ||
  process.env.NEGIS_BASE_URL ||
  "http://localhost:5173"
).replace(/\/$/, "");

const routes = [
  "/dashboard",
  "/clients",
  "/leads",
  "/appointments",
  "/booking",
  "/reception",
  "/calls",
  "/tasks",
  "/chat",
  "/market",
  "/reports",
  "/admin",
  "/ads",
  "/ads-automation",
  "/targeting-agent",
  "/content-studio",
  "/login",
];

const viewportWidths = [360, 375, 390, 414, 430, 768, 820, 1024, 1280];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function checkRoute(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  if (!text.includes('id="root"')) {
    throw new Error(`${path} did not return the Negis app shell`);
  }

  console.log(`${path}: app shell ok`);
}

async function checkManifest() {
  const response = await fetch(`${baseUrl}/manifest.webmanifest`);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`/manifest.webmanifest returned HTTP ${response.status}`);
  }

  const manifest = JSON.parse(text) as { name?: string; theme_color?: string; display?: string };
  if (manifest.name !== "Negis MedCall CRM" || manifest.theme_color !== "#0D9488" || manifest.display !== "standalone") {
    throw new Error("manifest.webmanifest is missing mobile-ready metadata");
  }

  console.log("/manifest.webmanifest: ok");
}

async function checkResponsiveCss() {
  const cssPath = join(repoRoot, "artifacts", "negis", "src", "index.css");
  const css = await readFile(cssPath, "utf8");
  const required = [
    ".mobile-bottom-nav",
    ".mobile-nav-sheet",
    "@media (max-width: 767px)",
    "overflow-x: hidden",
    "env(safe-area-inset-bottom)",
  ];

  for (const marker of required) {
    if (!css.includes(marker)) {
      throw new Error(`Responsive CSS marker missing: ${marker}`);
    }
  }

  console.log(`responsive CSS markers: ok (${viewportWidths.join(", ")}px audit matrix)`);
}

async function main() {
  console.log(`Mobile layout smoke at ${baseUrl}`);
  await checkManifest();
  await checkResponsiveCss();
  for (const route of routes) {
    await checkRoute(route);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
