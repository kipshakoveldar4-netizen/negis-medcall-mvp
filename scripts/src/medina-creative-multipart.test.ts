import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(path.join(root, "package.json"));
const ts = requireFromRoot("typescript") as typeof import("typescript");
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length);
assert.ok(!baseline || baseline === "db5a200", "only the reviewed local baseline is supported");
const serverFile = "lib/crm/server.ts";
const source = baseline
  ? execFileSync("git", ["show", `${baseline}:${serverFile}`], { cwd: root, encoding: "utf8" })
  : await readFile(path.join(root, serverFile), "utf8");
const ast = ts.createSourceFile(serverFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// Extract the real parser and its dependencies, without starting the server or
// loading its configuration, database clients, credentials, or environment files.
const declarations = new Map<string, import("typescript").Statement>();
for (const statement of ast.statements) {
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
    declarations.set(statement.name.text, statement);
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement);
    }
  } else if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
    const clause = statement.importClause;
    if (clause.name) declarations.set(clause.name.text, statement);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      declarations.set(clause.namedBindings.name.text, statement);
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        if (!binding.isTypeOnly) declarations.set(binding.name.text, statement);
      }
    }
  }
}
const selected = new Set<import("typescript").Statement>();
function include(name: string) {
  const statement = declarations.get(name);
  assert.ok(statement, `actual ${serverFile}:${name} exists`);
  if (selected.has(statement)) return;
  selected.add(statement);
  if (ts.isImportDeclaration(statement)) return;
  const visit = (node: import("typescript").Node) => {
    if (ts.isIdentifier(node) && declarations.has(node.text)) include(node.text);
    ts.forEachChild(node, visit);
  };
  visit(statement);
}
include("parseMultipartFormData");
const compiled = ts.transpileModule([
  ...ast.statements.filter((statement) => selected.has(statement)).map((statement) => statement.getText(ast)),
  "exports.parse = parseMultipartFormData;",
  "exports.prototypes = [Object.prototype, Function.prototype];",
].join("\n"), {
  fileName: "creative-multipart.actual-server.ts",
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
});
assert.deepEqual(compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error), []);

type Multipart = {
  fields: Record<string, unknown>;
  file?: { fieldName: string; fileName: string; mimeType: string; buffer: Buffer };
};
type Parser = (buffer: Buffer, contentType: string) => Multipart | Promise<Multipart>;
const actualBusboy = requireFromRoot("@fastify/busboy");
const externalCalls: string[] = [];
const importedModules: string[] = [];
const forbidden = (name: string): never => {
  externalCalls.push(name);
  throw new Error(`Forbidden external access: ${name}`);
};
const exports: { parse?: Parser; prototypes?: object[] } = {};
new Script(compiled.outputText, { filename: `${baseline ?? "working-tree"}:${serverFile}` }).runInNewContext({
  exports, Buffer, Error, TypeError,
  require(name: string) {
    importedModules.push(name);
    if (name === "@fastify/busboy") return actualBusboy;
    if (name === "content-type") return requireFromRoot(name);
    if (name === "node:stream" || name === "node:buffer") return requireFromRoot(name);
    return forbidden(`import ${name}`);
  },
  fetch: () => forbidden("network"),
  process: { env: new Proxy({}, { get: () => forbidden("environment"), ownKeys: () => forbidden("environment") }) },
}, { timeout: 1000 });
assert.ok(exports.parse && exports.prototypes);
const parse = exports.parse;
const prototypes = [Object.prototype, Function.prototype, ...exports.prototypes];

test("multipart harness uses the installed, real Busboy 3.2.4 without server integrations", () => {
  assert.equal(requireFromRoot("@fastify/busboy/package.json").version, "3.2.4");
  assert.equal(typeof actualBusboy, "function");
  if (!baseline) assert.ok(importedModules.includes("@fastify/busboy"), "current parser must use real Busboy");
});

test.afterEach(() => assert.deepEqual(externalCalls, [], "parser must not consult real integrations or environment"));

const boundary = "creative-test-boundary-7d91";
const contentType = `multipart/form-data; boundary=${boundary}`;
type Part = { headers: string[]; body: Buffer | string };
function field(name: string, value: string): Part {
  return { headers: [`Content-Disposition: form-data; name="${name}"`], body: value };
}
function file(body: Buffer | string = Buffer.from([0, 1, 127, 128, 254, 255]), options: {
  name?: string; fileName?: string; mimeType?: string;
} = {}): Part {
  return {
    headers: [
      `Content-Disposition: form-data; name="${options.name ?? "file"}"; filename="${options.fileName ?? "synthetic.png"}"`,
      `Content-Type: ${options.mimeType ?? "image/png"}`,
    ],
    body,
  };
}
function partBytes(part: Part, delimiter = boundary): Buffer {
  return Buffer.concat([
    Buffer.from(`--${delimiter}\r\n${part.headers.join("\r\n")}\r\n\r\n`),
    Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body),
    Buffer.from("\r\n"),
  ]);
}
function multipart(parts: Part[], closing = `--${boundary}--\r\n`, delimiter = boundary): Buffer {
  return Buffer.concat([...parts.map((part) => partBytes(part, delimiter)), Buffer.from(closing)]);
}
async function refused(body: Buffer, type = contentType) {
  await assert.rejects(async () => parse(body, type), (error: unknown) => {
    assert.ok(error instanceof Error, "reject malformed input with an error, never a partial form");
    assert.ok(error.message.length > 0);
    return true;
  });
}

test("binary bytes containing boundary substrings survive unchanged", { timeout: 5000 }, async () => {
  const bytes = Buffer.concat([
    Buffer.from([0, 255, 128, 13, 10, 1]),
    Buffer.from(`prefix--${boundary}suffix\n--${boundary}\0--${boundary}--`),
    Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
    Buffer.from([13, 10]),
  ]);
  const result = await parse(multipart([file(bytes)]), contentType);
  assert.ok(result.file);
  assert.ok(Buffer.isBuffer(result.file.buffer));
  assert.equal(result.file.buffer.length, bytes.length);
  assert.deepEqual(result.file.buffer, bytes);
  assert.deepEqual(Object.keys(result.fields), []);
});

for (const [fileName, mimeType] of [
  ["campaign final.png", "image/png"],
  ["frame;take=2.jpg", "image/jpeg"],
  ["synthetic.webm", "video/webm"],
]) {
  test(`file field name, filename and MIME survive: ${fileName}`, { timeout: 5000 }, async () => {
    const bytes = Buffer.from([0, 255, 129, 10, 13]);
    const result = await parse(multipart([file(bytes, { name: "creative", fileName, mimeType })]), contentType);
    assert.ok(result.file);
    assert.equal(result.file.fieldName, "creative");
    assert.equal(result.file.fileName, fileName);
    assert.equal(result.file.mimeType, mimeType);
    assert.deepEqual(result.file.buffer, bytes);
  });
}

test("quoted boundary and UTF-8, empty and multiline text fields work before and after the file", { timeout: 5000 }, async () => {
  const values = { title: "  Creative \u041c\u0435\u0434\u0438\u043d\u0430 \ud83c\udfa5  ", empty: "", notes: "line one\r\nline two\nline three" };
  const result = await parse(multipart([
    field("title", values.title), file(), field("empty", values.empty), field("notes", values.notes),
  ]), `multipart/form-data; boundary="${boundary}"`);
  assert.deepEqual(Object.keys(result.fields).sort(), Object.keys(values).sort());
  for (const [name, value] of Object.entries(values)) assert.equal(result.fields[name], value);
  assert.ok(result.file);
});

test("text-only multipart forms remain parseable", { timeout: 5000 }, async () => {
  const result = await parse(multipart([field("title", "Synthetic title")]), contentType);
  assert.equal(result.fields.title, "Synthetic title");
  assert.equal(result.file, undefined);
});

for (const [label, body] of [
  ["no closing delimiter", multipart([file()], "")],
  ["closing delimiter without its final hyphens", multipart([file()], `--${boundary}`)],
  ["closing delimiter with only one final hyphen", multipart([file()], `--${boundary}-`)],
  ["closing delimiter truncated inside boundary", multipart([file()], `--${boundary.slice(0, -3)}`)],
  ["unfinished second field after a complete file", multipart([file(), field("title", "unfinished")], "")],
  ["unfinished second file after a complete file", multipart([file(), file("unfinished", { name: "other" })], "")],
  ["unfinished trailing headers after a complete file", multipart([file()], `--${boundary}\r\nContent-Disposition: form-data; name="title"`)],
  ["unfinished trailing header separator after a complete file", multipart([file()], `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n`)],
] as Array<[string, Buffer]>) {
  test(`reject ${label} without accepting a prior file`, { timeout: 5000 }, async () => {
    await refused(body);
  });
}

for (const [label, type, delimiter] of [
  ["missing boundary", "multipart/form-data", boundary],
  ["empty unquoted boundary", "multipart/form-data; boundary=", ""],
  ["empty quoted boundary", 'multipart/form-data; boundary=""', ""],
  ["whitespace-only boundary", 'multipart/form-data; boundary="   "', "   "],
  ["unterminated quoted boundary", `multipart/form-data; boundary="${boundary}`, boundary],
  ["line break in boundary", 'multipart/form-data; boundary="bad\r\nboundary"', "bad\r\nboundary"],
  ["non-multipart content type", `application/json; boundary=${boundary}`, boundary],
]) {
  test(`reject ${label}`, { timeout: 5000 }, async () => {
    await refused(multipart([file()], `--${delimiter}--\r\n`, delimiter), type);
  });
}

for (const [label, parts] of [
  ["two files with the same name", [file(), file("second")]],
  ["two files with different names", [file(), file("second", { name: "other", fileName: "other.jpg", mimeType: "image/jpeg" })]],
  ["duplicate scalar fields before the file", [field("title", "first"), field("title", "second"), file()]],
  ["duplicate scalar fields surrounding the file", [field("title", "first"), file(), field("title", "second")]],
  ["duplicate empty scalar fields", [file(), field("title", ""), field("title", "")]],
] as Array<[string, Part[]]>) {
  test(`reject ${label}`, { timeout: 5000 }, async () => {
    await refused(multipart(parts));
  });
}

for (const key of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
  test(`prototype-like field ${key} is refused or stored without mutation`, { timeout: 5000 }, async () => {
    const before = prototypes.map((prototype) => Object.getOwnPropertyDescriptors(prototype));
    const value = '{"multipartPolluted":true}';
    let result: Multipart | undefined;
    try {
      try {
        result = await parse(multipart([field(key, value), field("title", "safe"), file()]), contentType);
      } catch (error) {
        assert.ok(error instanceof Error);
      }
      if (result) {
        assert.ok(Object.hasOwn(result.fields, key), "accepted scalar keys must not disappear or invoke inherited setters");
        assert.equal(result.fields[key], value);
        assert.equal(result.fields.title, "safe");
        assert.ok(result.file);
        const prototype = Object.getPrototypeOf(result.fields);
        assert.ok(prototype === null || prototypes.includes(prototype), "field input cannot replace the result prototype");
      }
    } finally {
      prototypes.forEach((prototype, index) => {
        assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), before[index], "input must not mutate host or parser prototypes");
      });
    }
  });
}

const fieldByteLimit = 64 * 1024;
const fieldCountLimit = 32;

test("a scalar field at the 64 KiB limit is preserved, not truncated", { timeout: 5000 }, async () => {
  const value = "x".repeat(fieldByteLimit);
  const result = await parse(multipart([file(), field("title", value)]), contentType);
  assert.ok(result.file);
  assert.equal(result.fields.title, value);
});

test("reject a scalar field one byte above 64 KiB instead of returning truncated text and a prior file", { timeout: 5000 }, async () => {
  await refused(multipart([file(), field("title", "x".repeat(fieldByteLimit + 1))]));
});

test("32 unique scalar fields plus a file fit the 33-part limit", { timeout: 5000 }, async () => {
  const parts = Array.from({ length: fieldCountLimit }, (_, index) => field(`field${index}`, `value${index}`));
  const result = await parse(multipart([file(), ...parts]), contentType);
  assert.ok(result.file);
  assert.equal(Object.keys(result.fields).length, fieldCountLimit);
  for (let index = 0; index < fieldCountLimit; index++) assert.equal(result.fields[`field${index}`], `value${index}`);
});

test("reject 33 unique scalar fields without relying on the part limit", { timeout: 5000 }, async () => {
  await refused(multipart(Array.from({ length: fieldCountLimit + 1 }, (_, index) => field(`field${index}`, "x"))));
});

test("reject excessive unique scalar fields instead of returning the accepted prefix", { timeout: 5000 }, async () => {
  await refused(multipart([file(), ...Array.from({ length: 1000 }, (_, index) => field(`field${index}`, "x"))]));
});

test("reject excessive parts even when non-form-data parts would otherwise be skipped", { timeout: 5000 }, async () => {
  const ignoredPart: Part = { headers: ['Content-Disposition: attachment; name="ignored"'], body: "x" };
  await refused(multipart([file(), ...Array.from({ length: 1000 }, () => ignoredPart)]));
});

for (const [label, tail] of [
  ["header without a colon", `--${boundary}\r\nContent-Disposition form-data; name="title"\r\n\r\nvalue\r\n--${boundary}--\r\n`],
  ["missing content disposition", `--${boundary}\r\nContent-Type: text/plain\r\n\r\nvalue\r\n--${boundary}--\r\n`],
  ["missing disposition name", `--${boundary}\r\nContent-Disposition: form-data\r\n\r\nvalue\r\n--${boundary}--\r\n`],
  ["bare LF inside a header", `--${boundary}\r\nContent-Disposition: form-data; name="bad\nname"\r\n\r\nvalue\r\n--${boundary}--\r\n`],
]) {
  test(`reject malformed trailing part: ${label}`, { timeout: 5000 }, async () => {
    await refused(multipart([file()], tail));
  });
}
