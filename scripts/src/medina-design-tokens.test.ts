import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// UI-2 — one design vocabulary.
//
// The product read as unfinished, and a large part of it was mechanical rather
// than aesthetic: two prefixes carried the same palette. --ng- and --negis-
// declared identical values for bg, surface, border, text, muted, primary,
// success, warning and error, and a page used whichever the author reached for.
// Every screen was correct on its own; what was impossible was changing a
// colour once. 153 references lived under the duplicate name.
//
// These tests keep the vocabulary single and complete. They read sources only —
// nothing here runs the app or touches production.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

async function sourceFiles(): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(tsx?|css)$/.test(entry.name)) found.push(full);
    }
  }
  await walk(negisSrc);
  return found;
}

test("D1 the retired --ng- vocabulary is gone, declarations and references alike", async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles()) {
    const source = await readFile(file, "utf8");
    // The prose above names the prefix; only code counts.
    if (/var\(--ng-/.test(source) || /^\s*--ng-[a-z0-9-]+\s*:/m.test(source)) {
      offenders.push(path.relative(repoRoot, file));
    }
  }
  assert.deepEqual(offenders, [], `these files still speak the retired vocabulary: ${offenders.join(", ")}`);
});

test("D2 every token a page asks for is declared", async () => {
  const css = await readFile(path.join(negisSrc, "index.css"), "utf8");
  const declared = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));

  const missing = new Map<string, string>();
  for (const file of await sourceFiles()) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/var\((--(?:negis|medina)-[a-z0-9-]+)/g)) {
      const token = match[1];
      // Shadcn primitives carry their own radix/sidebar/chart tokens; this test
      // owns the two vocabularies the product itself writes.
      if (!declared.has(token) && !missing.has(token)) {
        missing.set(token, path.relative(repoRoot, file));
      }
    }
  }

  assert.deepEqual(
    [...missing.entries()],
    [],
    "an undeclared token either resolves to nothing or falls back to a literal written beside it — "
      + "the clinic picker did the latter and sat a shade off the rest of the app, which is exactly how "
      + "a product reads as unfinished while every screen looks fine on its own",
  );
});

test("D3 no retired vocabulary survives, in code or in declarations", async () => {
  // --ng- went first; --medina- followed when the dark navigation slab became a
  // floating rail and the dark surfaces moved into --negis-dark*. A prefix that
  // nothing references is not harmless: it is the next author's false lead.
  const offenders: string[] = [];
  for (const file of await sourceFiles()) {
    const source = await readFile(file, "utf8");
    for (const retired of ["--ng-", "--medina-"]) {
      if (source.includes(`var(${retired}`) || new RegExp(`^\s*${retired}[a-z0-9-]+\s*:`, "m").test(source)) {
        offenders.push(`${path.relative(repoRoot, file)} → ${retired}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `retired token prefixes are still alive: ${offenders.join(", ")}`);
});

test("D4 the welcome screen offers only what the product can deliver", async () => {
  const landing = await readFile(path.join(negisSrc, "pages", "Landing.tsx"), "utf8");
  const code = landing
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

  for (const promise of ["Попробовать бесплатно", "Зарегистрироваться", "Создать аккаунт", "Начать бесплатно"]) {
    assert.ok(
      !code.includes(promise),
      `«${promise}» offers self-service signup, which does not exist — the owner opens access`,
    );
  }
  assert.ok(
    code.includes("Доступ новой клинике открывает владелец пространства"),
    "the page has to say plainly how a new clinic gets in, on the first screen and not only in the modal",
  );
});

test("D5 the welcome screen keeps the links Meta review depends on", async () => {
  const landing = await readFile(path.join(negisSrc, "pages", "Landing.tsx"), "utf8");
  for (const href of ["/privacy", "/terms", "/data-deletion"]) {
    assert.ok(
      landing.includes(`href="${href}"`),
      `${href} must stay reachable from the entry page — the Meta app review checks it`,
    );
  }
});

// The surface language, pinned.
//
// UI-5/UI-6 moved every card off the hairline-bordered 8–10px tile and every
// control off the square grey rectangle. Both changes live in one place on
// purpose — the whole product moves together or the screens disagree with each
// other, which is the specific way this app read as thrown together. A later
// author reaching for `border: 1px solid var(--negis-border); border-radius:
// 10px` on a shared surface would undo it silently and only on some screens.

const SURFACE_RULES = [".negis-glass", ".negis-glass-hero", ".neu-card", ".neu-sm", ".neu"];
const PILL_CONTROLS = [".neu-btn", ".neu-btn-primary", ".neu-btn-success", ".neu-btn-danger", ".neu-icon-btn"];

function ruleBody(css: string, selector: string): string {
  // Only top-level component rules; the mobile media query redeclares some of
  // these deliberately and is checked separately.
  const at = css.indexOf(`\n  ${selector} {`);
  assert.ok(at >= 0, `${selector} is no longer declared in index.css`);
  return css.slice(at, css.indexOf("}", at));
}

test("D7 shared card surfaces carry no hairline border and no small radius", async () => {
  const css = await readFile(path.join(negisSrc, "index.css"), "utf8");
  const offenders: string[] = [];
  for (const selector of SURFACE_RULES) {
    const body = ruleBody(css, selector);
    if (/border:\s*1px solid/.test(body)) offenders.push(`${selector} → hairline border`);
    const radius = /border-radius:\s*(\d+)px/.exec(body);
    if (radius && Number(radius[1]) < 18) offenders.push(`${selector} → radius ${radius[1]}px`);
  }
  assert.deepEqual(
    offenders,
    [],
    `a bordered tile beside a shadowed card is the mismatch that reads as unfinished: ${offenders.join(", ")}`,
  );
});

test("D8 shared controls are pills, and the primary action is the black one", async () => {
  const css = await readFile(path.join(negisSrc, "index.css"), "utf8");
  const offenders: string[] = [];
  for (const selector of PILL_CONTROLS) {
    const body = ruleBody(css, selector);
    if (!/border-radius:\s*999px/.test(body)) offenders.push(`${selector} → not a pill`);
    if (/border:\s*1px solid/.test(body)) offenders.push(`${selector} → hairline border`);
  }
  assert.deepEqual(offenders, [], `controls drifted back to squared rectangles: ${offenders.join(", ")}`);

  assert.match(
    ruleBody(css, ".neu-btn-primary"),
    /background:\s*var\(--negis-black\)/,
    "the primary action is the black pill; mint marks where you are and which number matters, "
      + "and a second filled accent competing with it is what made the old screens noisy",
  );
});

test("D10 no shared control is painted in the page's own background colour", async () => {
  // Caught by rendering the control inventory against the built stylesheet:
  // .neu-btn and .neu-icon-btn were filled with --negis-ground, which is also
  // what PageLayout paints the page with. Inside a card they read fine; on a
  // page toolbar — where the export and refresh buttons actually live — they
  // disappeared completely. A control has to survive both backgrounds.
  const css = await readFile(path.join(negisSrc, "index.css"), "utf8");
  const pageBackground = /--negis-ground:\s*([^;]+);/.exec(css)?.[1].trim();
  assert.ok(pageBackground, "--negis-ground is the page background and must stay declared");

  const offenders: string[] = [];
  for (const selector of PILL_CONTROLS) {
    const body = ruleBody(css, selector);
    const background = /background:\s*([^;]+);/.exec(body)?.[1].trim();
    if (background === "var(--negis-ground)") offenders.push(selector);
  }
  assert.deepEqual(
    offenders,
    [],
    `these controls vanish on a page toolbar, because that is exactly the colour behind them: ${offenders.join(", ")}`,
  );
});

test("D9 the retired .neu-lg surface is gone from stylesheet and markup", async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles()) {
    const source = await readFile(file, "utf8");
    if (/(^|\s|")neu-lg(\s|"|\s*\{)/.test(source)) offenders.push(path.relative(repoRoot, file));
  }
  assert.deepEqual(
    offenders,
    [],
    `a surface class no page uses is the next author's false lead: ${offenders.join(", ")}`,
  );
});

test("D11 the product has exactly one metric card, not one per screen", async () => {
  // Six screens had each grown their own: ClientMetricCard, HistoryMetricCard,
  // ControlMetricCard and three plain MetricCards, all drawing the same thing
  // with different icon sizes, weights and — on Записи and админке — colours
  // hard-coded past the palette. That is why changing the brand green left two
  // screens behind: there was no single place to change.
  const definitions: string[] = [];
  for (const file of await sourceFiles()) {
    if (!/\.tsx$/.test(file)) continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/^(?:export\s+)?function\s+(\w*Metric\w*Card)\b/gm)) {
      // Separators are normalized so the expectation reads the same on Windows.
      definitions.push(`${path.relative(repoRoot, file).split(path.sep).join("/")} → ${match[1]}`);
    }
  }
  assert.deepEqual(
    definitions,
    ["artifacts/negis/src/components/ui/metric-card.tsx → MetricCard"],
    `a screen that draws its own metric card stops following the shared one: ${definitions.join(", ")}`,
  );
});

test("D12 the retired teal is gone from every screen", async () => {
  // --negis-primary moved to the mint family. Screens that had written the old
  // value out as a literal, or reached for Tailwind's teal-*, kept the previous
  // brand colour and became the odd ones out. Status tints are not brand and
  // stay: this test names only the retired brand values.
  const retired = ["#0F766E", "#115E59", "#0B4F4A", "#E4F2EF"];
  const offenders: string[] = [];
  for (const file of await sourceFiles()) {
    const source = await readFile(file, "utf8");
    for (const value of retired) {
      if (new RegExp(value, "i").test(source)) offenders.push(`${path.relative(repoRoot, file)} → ${value}`);
    }
  }
  assert.deepEqual(offenders, [], `the old brand colour still shows on these screens: ${offenders.join(", ")}`);
});

test("D6 the welcome screen paints from the token vocabulary, not from literals", async () => {
  const landing = await readFile(path.join(negisSrc, "pages", "Landing.tsx"), "utf8");
  const presentation = landing.slice(landing.indexOf("  return ("), landing.indexOf("{/* Modal */}"));

  const literals = [...presentation.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0])
    .filter((hex) => hex.toUpperCase() !== "#FFFFFF");
  assert.deepEqual(
    literals,
    [],
    `hard-coded colours drift away from the palette on the very first screen a visitor sees: ${literals.join(", ")}`,
  );
});
