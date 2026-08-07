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
