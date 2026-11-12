import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const limit = 3500;
const emoji = "\uD83D\uDE00";

type Splitters = {
  splitLongText(text: string, maxLength: number): string[];
  splitTelegramMessage(text: string, maxLength?: number): string[];
};

async function localSplitters(): Promise<Splitters> {
  const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
  const relativePath = "api/content-studio/[...path].ts";
  const source = await readFile(path.join(root, relativePath), "utf8");
  const ast = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ["splitLongText", "splitTelegramMessage"] as const;
  const declarations = names.map((name) => {
    const matches = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(matches.length, 1, `execute exactly one actual ${name} declaration`);
    return matches[0].getText(ast);
  });

  // Execute only the real splitters, without server imports, process, require or fetch.
  const compiled = ts.transpileModule([
    ...declarations,
    ...names.map((name) => `exports.${name} = ${name};`),
  ].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exported: Partial<Splitters> = {};
  new Script(compiled, { filename: "telegram-chunk-boundaries.fixture.cjs" }).runInNewContext({
    exports: exported,
  }, { timeout: 1000 });
  for (const name of names) assert.equal(typeof exported[name], "function");
  return exported as Splitters;
}

const splitters = localSplitters();

async function split(name: keyof Splitters, text: string): Promise<string[]> {
  const actual = await splitters;
  // Convert the VM array to this realm; exercise Telegram's default limit.
  return Array.from(name === "splitLongText"
    ? actual.splitLongText(text, limit)
    : actual.splitTelegramMessage(text));
}

function assertChunks(chunks: string[]): void {
  assert.ok(chunks.length > 0, "nonempty input must produce at least one chunk");
  chunks.forEach((chunk, part) => {
    assert.equal(typeof chunk, "string");
    assert.ok(chunk.length > 0, `chunk ${part + 1} must not be empty`);
    assert.ok(chunk.length <= limit, `chunk ${part + 1}: ${chunk.length} UTF-16 code units exceeds ${limit}`);
    for (let offset = 0; offset < chunk.length; offset++) {
      const unit = chunk.charCodeAt(offset);
      const location = `chunk ${part + 1}, UTF-16 offset ${offset}, length ${chunk.length}`;
      if (unit >= 0xD800 && unit <= 0xDBFF) {
        const next = chunk.charCodeAt(offset + 1);
        assert.ok(next >= 0xDC00 && next <= 0xDFFF, `${location}: unpaired high surrogate U+${unit.toString(16).toUpperCase()}`);
        offset++;
      } else {
        assert.ok(unit < 0xDC00 || unit > 0xDFFF, `${location}: unpaired low surrogate U+${unit.toString(16).toUpperCase()}`);
      }
    }
  });
}

const asciiCases = [
  { name: "3500 code units stay in one chunk", chunks: ["A".repeat(limit - 1) + "Z"] },
  { name: "3501 code units split without loss", chunks: ["A".repeat(limit), "Z"] },
  { name: "exactly two full chunks have no empty tail", chunks: ["A".repeat(limit), "B".repeat(limit)] },
  { name: "a long unbroken block preserves all three chunks in order", chunks: ["A".repeat(limit), "B".repeat(limit), "tail"] },
];

const safeEmojiCases = [
  { name: "emoji ending at 3500 stays intact", chunks: ["A".repeat(limit - 2) + emoji, "Z"] },
  { name: "emoji starting after 3500 stays intact", chunks: ["A".repeat(limit), emoji + "Z"] },
];

const crossingEmojiCases = [
  { name: "emoji across 3500 must not split a surrogate pair", text: "A".repeat(limit - 1) + emoji },
  { name: "emoji across 7000 must not split a surrogate pair", text: "A".repeat(limit) + "B".repeat(limit - 1) + emoji + "Z" },
];

for (const name of ["splitLongText", "splitTelegramMessage"] as const) {
  for (const fixture of [...asciiCases, ...safeEmojiCases]) {
    test(`${name}: ${fixture.name}`, async () => {
      const input = fixture.chunks.join("");
      const chunks = await split(name, input);
      assert.equal(chunks.join(""), input, "preserve every code unit in its original order");
      assertChunks(chunks);
      assert.deepEqual(chunks, fixture.chunks);
    });
  }

  for (const fixture of crossingEmojiCases) {
    test(`${name}: ${fixture.name}`, async () => {
      const chunks = await split(name, fixture.text);
      assert.equal(chunks.join(""), fixture.text, "reassembly alone must not hide invalid individual chunks");
      assertChunks(chunks);
      assert.ok(chunks.length >= 2);
    });
  }
}

test("splitTelegramMessage: normalizes outer/block whitespace and repeated blank lines only", async () => {
  const input = " \n\t first  line\nsecond line \t\n\n\n  middle  spaces \t\n\n\n\n final\t \n ";
  const expected = "first  line\nsecond line\n\nmiddle  spaces\n\nfinal";
  const chunks = await split("splitTelegramMessage", input);
  assertChunks(chunks);
  assert.deepEqual(chunks, [expected]);
});

test("splitTelegramMessage: multiple paragraphs fit exactly 3500 including their separator", async () => {
  const paragraphs = ["A".repeat(1700), "B".repeat(1798), "last paragraph"];
  const input = ` \n${paragraphs[0]} \t\n\n\n ${paragraphs[1]}\t\n\n\n\n ${paragraphs[2]} \n`;
  const chunks = await split("splitTelegramMessage", input);
  assertChunks(chunks);
  assert.deepEqual(chunks, [paragraphs.slice(0, 2).join("\n\n"), paragraphs[2]]);
  assert.equal(chunks[0].length, limit);
  assert.equal(chunks.join("\n\n"), paragraphs.join("\n\n"), "preserve normalized paragraph content and order");
});

test("splitTelegramMessage: paragraphs totaling 3501 split at the paragraph boundary", async () => {
  const paragraphs = ["A".repeat(1700), "B".repeat(1799)];
  const input = paragraphs.join("\n\n");
  assert.equal(input.length, limit + 1);
  const chunks = await split("splitTelegramMessage", input);
  assertChunks(chunks);
  assert.deepEqual(chunks, paragraphs);
  assert.equal(chunks.join("\n\n"), input);
});

test("splitTelegramMessage: long block flushes preceding paragraphs and preserves following paragraphs", async () => {
  const longParts = ["A".repeat(limit), "B".repeat(limit), "tail"];
  const input = ` \tintro \n\n\n ${longParts.join("")} \t\n\n outro\n\n\n end \n`;
  const chunks = await split("splitTelegramMessage", input);
  assertChunks(chunks);
  assert.deepEqual(chunks, ["intro", ...longParts, "outro\n\nend"]);
  // Only paragraph boundaries regain separators; hard-split block pieces concatenate.
  const restored = [chunks[0], chunks.slice(1, 4).join(""), chunks[4]].join("\n\n");
  assert.equal(restored, ["intro", longParts.join(""), "outro", "end"].join("\n\n"));
});
