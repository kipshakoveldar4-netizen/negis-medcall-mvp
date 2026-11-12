import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

type PhotoTexts = { headline: string; offer: string; cta: string; disclaimer: string };
type Layout = "top_bottom" | "gradient_bottom" | "medical_card" | "minimal_premium";
type RenderInput = { imageUrl: string; width: number; height: number; layout: Layout; texts: PhotoTexts };
type Renderer = (input: RenderInput) => Promise<Blob | null>;
type TextDraw = { text: string; font: string; size: number; left: number; top: number; width: number; height: number };
type Shape = { kind: "rect" | "rounded"; left: number; top: number; width: number; height: number; color: unknown };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const studioPage = path.join(repoRoot, "artifacts", "negis", "src", "pages", "ContentStudio.tsx");
const sourceUrl = "blob:synthetic-photo-export-source";
const formats = [
  { id: "story", width: 1080, height: 1920 },
  { id: "feed", width: 1080, height: 1080 },
  { id: "universal", width: 1080, height: 1350 },
] as const;
const layouts: Layout[] = ["top_bottom", "gradient_bottom", "medical_card", "minimal_premium"];
const normalTexts: PhotoTexts = {
  headline: "Консультация специалиста",
  offer: "Подберем удобное время приема",
  cta: "Записаться",
  disclaimer: "Имеются противопоказания. Необходима консультация специалиста.",
};
const reproducedCta = "Получить подробную консультацию по условиям программы";

// Extract executable function dependencies, never importing the app, its SDK or configuration.
const rendererProgram = (async () => {
  const ts = createRequire(path.join(repoRoot, "package.json"))("typescript") as typeof import("typescript");
  const source = await readFile(studioPage, "utf8");
  const ast = ts.createSourceFile(studioPage, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = new Map<string, import("typescript").FunctionDeclaration>();
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement);
  }
  const renderer = functions.get("renderPhotoCreative");
  assert.ok(renderer?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword), "use the actual exported renderer");
  const selected = new Set<string>();
  function include(name: string) {
    if (selected.has(name)) return;
    const declaration = functions.get(name);
    assert.ok(declaration, `missing renderer function ${name}`);
    selected.add(name);
    const visit = (node: import("typescript").Node) => {
      if (ts.isIdentifier(node) && functions.has(node.text)) include(node.text);
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  }
  include("renderPhotoCreative");
  return ts.transpileModule([...selected].map((name) => functions.get(name)!.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
})();

function fontSize(font: string) {
  const size = Number(font.match(/([\d.]+)px/)?.[1]);
  assert.ok(Number.isFinite(size) && size > 0, `invalid canvas font: ${font}`);
  return size;
}

// Deterministic approximate advances, not a second implementation of wrapping or fitting.
function measure(text: string, font: string) {
  const size = fontSize(font);
  let units = 0;
  for (const character of text) {
    units += /\s/u.test(character) ? 0.28
      : /[ilI1.,:;!|'`]/u.test(character) ? 0.28
      : /[жшщюмфыъw@%]/iu.test(character) ? 0.85
      : /[A-ZА-ЯЁ]/u.test(character) ? 0.66
      : character.codePointAt(0)! > 0xffff ? 1
      : 0.55;
  }
  const family = /Georgia|Times New Roman/.test(font) ? 1.03 : 1;
  const weight = Number(font.match(/^\s*(\d{3})\s/)?.[1] ?? 400) >= 700 ? 1.03 : 1;
  return { width: units * size * family * weight, actualBoundingBoxAscent: size * 0.8,
    actualBoundingBoxDescent: size * 0.2, fontBoundingBoxAscent: size * 0.8, fontBoundingBoxDescent: size * 0.2 };
}

async function canvasFixture(options: { nullBlob?: boolean; imageError?: boolean } = {}) {
  const textDraws: TextDraw[] = [];
  const shapes: Shape[] = [];
  const imageLoads: string[] = [];
  const imageDraws: number[][] = [];
  const exports = {} as { renderPhotoCreative: Renderer };
  const encodings: { width: number; height: number; type: string; quality?: number; blob: Blob | null; bytes: string }[] = [];
  let rounded: { left: number; top: number; right: number; bottom: number } | undefined;
  const ctx = {
    font: "10px sans-serif", textAlign: "start", textBaseline: "alphabetic", fillStyle: undefined as unknown,
    measureText(text: string) { return measure(text, this.font); },
    fillText(text: string, x: number, y: number, maxWidth?: number) {
      const metrics = measure(text, this.font), size = fontSize(this.font);
      const width = maxWidth === undefined ? metrics.width : Math.min(metrics.width, maxWidth);
      const left = this.textAlign === "center" ? x - width / 2
        : this.textAlign === "right" || this.textAlign === "end" ? x - width : x;
      const top = this.textBaseline === "top" ? y : this.textBaseline === "middle" ? y - size / 2
        : this.textBaseline === "bottom" ? y - size : y - size * 0.8;
      textDraws.push({ text, font: this.font, size, left, top, width, height: size });
    },
    drawImage(image: { src: string }, ...coordinates: number[]) {
      assert.equal(image.src, sourceUrl); imageDraws.push(coordinates);
    },
    fillRect(left: number, top: number, width: number, height: number) {
      shapes.push({ kind: "rect", left, top, width, height, color: this.fillStyle });
    },
    beginPath() { rounded = undefined; },
    moveTo(_x: number, _y: number) {},
    arcTo(x1: number, y1: number, x2: number, y2: number, _radius: number) {
      rounded = rounded ? { left: Math.min(rounded.left, x1, x2), top: Math.min(rounded.top, y1, y2),
        right: Math.max(rounded.right, x1, x2), bottom: Math.max(rounded.bottom, y1, y2) }
        : { left: Math.min(x1, x2), top: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
    },
    closePath() {},
    fill() {
      assert.ok(rounded, "a rounded shape must have a recorded path");
      shapes.push({ kind: "rounded", left: rounded.left, top: rounded.top,
        width: rounded.right - rounded.left, height: rounded.bottom - rounded.top, color: this.fillStyle });
    },
    createLinearGradient(..._coordinates: number[]) { return { addColorStop(_position: number, _color: string) {} }; },
  };
  const canvas = {
    width: 0, height: 0,
    getContext(kind: string) { assert.equal(kind, "2d"); return ctx; },
    toBlob(callback: (blob: Blob | null) => void, type: string, quality?: number) {
      // The payload is intentionally not a JPEG codec: verify the real renderer returns this exact callback result.
      const bytes = JSON.stringify({ marker: "synthetic toBlob output", width: this.width, height: this.height, draws: textDraws.length });
      const blob = options.nullBlob ? null : new Blob([bytes], { type });
      encodings.push({ width: this.width, height: this.height, type, quality, blob, bytes });
      queueMicrotask(() => callback(blob));
    },
  };
  class FixtureImage {
    width = 640;
    height = 480;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private value = "";
    get src() { return this.value; }
    set src(value: string) {
      assert.equal(value, sourceUrl, "only the synthetic in-memory source may load");
      this.value = value; imageLoads.push(value);
      queueMicrotask(() => options.imageError ? this.onerror?.() : this.onload?.());
    }
  }
  const forbidden = () => { throw new Error("Photo export must not access imports, providers, SDK, storage or network"); };
  new Script(await rendererProgram, { filename: "extracted-content-studio-photo-renderer.cjs" }).runInNewContext({
    exports, Blob, Image: FixtureImage,
    document: { createElement(tag: string) { assert.equal(tag, "canvas"); return canvas; } },
    require: forbidden, fetch: forbidden, XMLHttpRequest: forbidden, WebSocket: forbidden,
    supabase: new Proxy({}, { get: forbidden }), localStorage: new Proxy({}, { get: forbidden }),
  }, { timeout: 1000 });
  return { render: exports.renderPhotoCreative, canvas, textDraws, shapes, imageLoads, imageDraws, encodings };
}

type CanvasFixture = Awaited<ReturnType<typeof canvasFixture>>;
const canonical = (text: string) => text.replace(/\s/gu, "").toUpperCase();
const caption = (draw: TextDraw) => JSON.stringify(draw.text.length > 65 ? `${draw.text.slice(0, 65)}...` : draw.text);

function assertTextGeometry(fixture: CanvasFixture, input: RenderInput) {
  const epsilon = 0.01;
  assert.ok(fixture.textDraws.length >= 4, "a successful image must actually paint every nonempty text field");
  for (const draw of fixture.textDraws) {
    assert.ok([draw.left, draw.top, draw.width, draw.height].every(Number.isFinite), `nonfinite text bounds for ${caption(draw)}`);
    assert.ok(draw.size >= 12, `unreadable font for ${caption(draw)}: ${draw.font}`);
    assert.ok(draw.left >= -epsilon && draw.left + draw.width <= input.width + epsilon,
      `horizontal clipping for ${caption(draw)}: ${draw.left}..${draw.left + draw.width}, canvas width ${input.width}`);
    assert.ok(draw.top >= -epsilon && draw.top + draw.height <= input.height + epsilon,
      `vertical clipping for ${caption(draw)}: ${draw.top}..${draw.top + draw.height}, canvas height ${input.height}`);
  }
  for (let i = 0; i < fixture.textDraws.length; i++) {
    for (let j = i + 1; j < fixture.textDraws.length; j++) {
      const a = fixture.textDraws[i], b = fixture.textDraws[j];
      const overlapX = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
      assert.ok(overlapX <= epsilon || overlapY <= epsilon, `text overlap: ${caption(a)} with ${caption(b)}`);
    }
  }
  const painted = canonical(fixture.textDraws.map((draw) => draw.text.replace(/^→\s*/u, "")).join(""));
  const supplied = canonical(input.texts.headline + input.texts.offer + input.texts.cta + input.texts.disclaimer);
  assert.ok(painted === supplied, "successful export must preserve all copy, without ellipsis, truncation, duplication or omission");
  const cta = fixture.textDraws.find((draw) => draw.text === input.texts.cta || draw.text === `→ ${input.texts.cta}`);
  assert.ok(cta, "paint the complete CTA");
  assert.ok(fixture.textDraws.some((draw) => draw.text === input.texts.disclaimer), "paint the complete disclaimer");
  if (input.layout === "top_bottom") {
    const button = fixture.shapes.find((shape) => shape.kind === "rounded" && shape.color === "#0D9488");
    assert.ok(button, "record the CTA button");
    assert.ok(cta.left >= button.left && cta.left + cta.width <= button.left + button.width, "CTA must also fit its button");
  }
  if (input.layout === "minimal_premium") {
    const underline = fixture.shapes.find((shape) => shape.kind === "rect" && shape.height === 2);
    assert.ok(underline, "record the CTA underline");
    assert.ok(Math.abs(underline.width - cta.width) <= epsilon, "underline must use the fitted CTA width");
  }
  return cta;
}

async function assertExport(fixture: CanvasFixture, input: RenderInput, result: Blob | null) {
  assert.equal(fixture.encodings.length, 1, "encode exactly once on successful render");
  const encoding = fixture.encodings[0];
  assert.deepEqual({ width: encoding.width, height: encoding.height, type: encoding.type },
    { width: input.width, height: input.height, type: "image/jpeg" });
  assert.ok(encoding.quality !== undefined && encoding.quality > 0 && encoding.quality <= 1);
  assert.ok(result instanceof Blob, "return the toBlob callback's Blob, not a fabricated success");
  assert.equal(result, encoding.blob);
  assert.equal(result.type, "image/jpeg");
  assert.equal(await result.text(), encoding.bytes, "preserve the actual toBlob output bytes");
  assert.deepEqual(fixture.imageLoads, [sourceUrl]);
  assert.equal(fixture.imageDraws.length, 1, "paint the source image");
  return assertTextGeometry(fixture, input);
}

function assertRussianOverflow(error: unknown, fixture: CanvasFixture) {
  const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : "";
  assert.match(message, /[А-Яа-яЁё]/u, "overflow must explain the problem in Russian");
  assert.match(message, /не помещ|слишком|сократ|уменьш/iu, "overflow must explain that the copy needs shortening");
  assert.equal(fixture.encodings.length, 0, "rejected copy must never reach toBlob");
}

const scenarios: { name: string; texts: PhotoTexts; rejection: "never" | "allowed" | "required" }[] = [
  { name: "normal Russian copy", texts: normalTexts, rejection: "never" },
  { name: "reproduced long CTA", texts: { ...normalTexts, cta: reproducedCta }, rejection: "allowed" },
  { name: "long unbroken Russian headline", texts: { ...normalTexts, headline: "Сверхдлинноенеразрывноеслово".repeat(3) }, rejection: "allowed" },
  { name: "long full Russian disclaimer", texts: { ...normalTexts,
    disclaimer: "Имеются противопоказания. Перед выбором программы необходимо получить индивидуальную консультацию специалиста." }, rejection: "allowed" },
  { name: "excessive headline", texts: { ...normalTexts, headline: "Очень подробная информация о программе ".repeat(100) }, rejection: "required" },
  { name: "excessive offer", texts: { ...normalTexts, offer: "Подробные условия выбора программы и времени приема ".repeat(100) }, rejection: "required" },
  { name: "excessive CTA", texts: { ...normalTexts, cta: "Получить подробную консультацию ".repeat(50) }, rejection: "required" },
  { name: "excessive disclaimer", texts: { ...normalTexts, disclaimer: "Необходима индивидуальная консультация специалиста. ".repeat(50) }, rejection: "required" },
];

for (const format of formats) {
  for (const layout of layouts) {
    for (const scenario of scenarios) {
      test(`photo export ${format.id} ${layout}: ${scenario.name}`, { timeout: 5000 }, async () => {
        const fixture = await canvasFixture();
        const input: RenderInput = { imageUrl: sourceUrl, width: format.width, height: format.height, layout, texts: { ...scenario.texts } };
        let result: Blob | null;
        try { result = await fixture.render(input); }
        catch (error) {
          assertRussianOverflow(error, fixture);
          assert.notEqual(scenario.rejection, "never", "normal copy must render");
          assert.ok(!(scenario.name === "reproduced long CTA" && layout === "gradient_bottom"), "the reproduced CTA must fit after shrinking");
          return;
        }
        assert.notEqual(scenario.rejection, "required", "excessive copy must explicitly reject instead of exporting a clipped JPEG");
        const cta = await assertExport(fixture, input, result);
        if (scenario.name === "reproduced long CTA") {
          assert.ok(cta.size < Math.round(input.width * 0.038), "long CTA must use a genuinely smaller font, without truncation");
        }
      });
    }
  }
}

test("photo export returns a null toBlob result honestly", async () => {
  const fixture = await canvasFixture({ nullBlob: true });
  const input: RenderInput = { imageUrl: sourceUrl, width: 1080, height: 1080, layout: "gradient_bottom", texts: normalTexts };
  assert.equal(await fixture.render(input), null);
  assert.equal(fixture.encodings.length, 1);
  assert.equal(fixture.encodings[0].blob, null);
  assertTextGeometry(fixture, input);
});

test("photo export source decode failure cannot encode a JPEG", async () => {
  const fixture = await canvasFixture({ imageError: true });
  await assert.rejects(fixture.render({ imageUrl: sourceUrl, width: 1080, height: 1080, layout: "gradient_bottom", texts: normalTexts }),
    (error: unknown) => typeof error === "object" && error !== null && "message" in error && /Не удалось загрузить фото/u.test(String(error.message)));
  assert.equal(fixture.encodings.length, 0);
  assert.deepEqual(fixture.textDraws, []);
});
