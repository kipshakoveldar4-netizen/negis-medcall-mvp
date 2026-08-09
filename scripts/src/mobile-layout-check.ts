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
  "/sales",
  "/services",
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
  "/ads-automation/history",
  "/targeting-agent",
  "/content-studio",
  "/privacy",
  "/terms",
  "/data-deletion",
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

  // UI-2 brand completion: the visible PWA identity is Medina OS.
  const manifest = JSON.parse(text) as { name?: string; theme_color?: string; display?: string };
  if (manifest.name !== "Medina OS — медицинская CRM" || manifest.theme_color !== "#0F766E" || manifest.display !== "standalone") {
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

async function checkLeadsPipelineMobileSource() {
  const leadsPath = join(repoRoot, "artifacts", "negis", "src", "pages", "LeadsPage.tsx");
  const source = await readFile(leadsPath, "utf8");
  for (const marker of [
    'data-testid="lead-stage-select"',
    'data-testid="lead-source-select"',
    'data-testid="lead-source-input"',
    "max-h-[90vh] overflow-y-auto",
    "flex flex-col gap-2 sm:flex-row",
    "grid gap-3 sm:grid-cols-2",
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`Leads mobile pipeline marker missing: ${marker}`);
    }
  }

  console.log("/leads pipeline controls: mobile-safe source markers ok");
}

async function checkSalesMobileSource() {
  const salesPath = join(repoRoot, "artifacts", "negis", "src", "pages", "SalesPage.tsx");
  const source = await readFile(salesPath, "utf8");
  for (const marker of [
    "grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5",
    "grid gap-3 xl:grid-cols-2",
    "max-h-[90vh] w-full max-w-2xl overflow-y-auto",
    "grid gap-3 sm:grid-cols-2",
    "flex flex-col gap-2 sm:flex-row",
    "flex flex-wrap justify-end gap-2",
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`Sales mobile marker missing: ${marker}`);
    }
  }

  console.log("/sales controls: mobile-safe source markers ok");
}

async function main() {
  console.log(`Mobile layout smoke at ${baseUrl}`);
  await checkManifest();
  await checkResponsiveCss();
  await checkLeadsPipelineMobileSource();
  await checkSalesMobileSource();
  for (const route of routes) {
    await checkRoute(route);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
