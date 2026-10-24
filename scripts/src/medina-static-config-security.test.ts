import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireRoot = createRequire(path.join(root, "package.json"));
const requireVercel = createRequire(requireRoot.resolve("@vercel/node"));
const requireStatic = createRequire(requireVercel.resolve("@vercel/static-config"));
const staticConfig = requireStatic("./index.js");
const { validate } = requireStatic("./validation.js");
const { Project } = requireStatic("ts-morph");
const requireSpec = createRequire(path.join(root, "lib/api-spec/package.json"));
const requireOrval = createRequire(requireSpec.resolve("orval"));
const requireScalar = createRequire(requireOrval.resolve("@scalar/openapi-parser"));
const ReferenceAjv = requireScalar("ajv");
const reference = new ReferenceAjv();

test("static-config security: scoped parent resolves patched AJV and URI parser", () => {
  assert.equal(requireVercel("@vercel/static-config/package.json").version, "3.4.0");
  assert.equal(requireStatic("ajv/package.json").version, "8.20.0");
  assert.equal(requireScalar("ajv/package.json").version, "8.20.0");
  const requireAjv = createRequire(requireStatic.resolve("ajv"));
  assert.equal(requireAjv("fast-uri/package.json").version, "3.1.9");
  assert.equal(new (requireStatic("ajv"))().opts.$data, undefined);
});

test("static-config security: override remains parent-scoped with release-age defense", () => {
  const yaml = requireOrval("js-yaml");
  const workspace = yaml.load(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"));
  const lock = yaml.load(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  const selector = "@vercel/static-config@3.4.0>ajv";
  assert.equal(workspace.minimumReleaseAge, 1440);
  assert.equal(workspace.overrides[selector], "8.20.0");
  assert.equal(lock.overrides[selector], "8.20.0");
  assert.deepEqual(Object.keys(workspace.overrides).filter((key) => key.includes("ajv")), [selector]);
  assert.equal(lock.snapshots["@vercel/static-config@3.4.0"].dependencies.ajv, "8.20.0");
  assert.equal(lock.snapshots["ajv@8.6.3"], undefined);
});

const validConfigs: Array<[string, unknown]> = [
  ["empty object", {}],
  ["x86 architecture", { architecture: "x86_64" }],
  ["ARM architecture", { architecture: "arm64" }],
  ["runtime", { runtime: "nodejs22.x" }],
  ["memory", { memory: 1024 }],
  ["numeric duration", { maxDuration: 60 }],
  ["maximum duration", { maxDuration: "max" }],
  ["cancellation", { supportsCancellation: true }],
  ["region list", { regions: ["iad1", "fra1"] }],
  ["empty region list", { regions: [] }],
  ["all regions", { regions: "all" }],
  ["default regions", { regions: "default" }],
  ["automatic regions", { regions: "auto" }],
  ["preferred region", { preferredRegion: "iad1" }],
  ["preferred region list", { preferredRegion: ["iad1"] }],
  ["web API flag", { useWebApi: false }],
  ["unknown fields preserved", { additionalField: "unchanged" }],
];
const invalidConfigs: Array<[string, unknown]> = [
  ["null", null],
  ["array", []],
  ["string", "text"],
  ["unknown architecture", { architecture: "arm" }],
  ["numeric runtime", { runtime: 42 }],
  ["string memory", { memory: "1024" }],
  ["string duration", { maxDuration: "60" }],
  ["boolean duration", { maxDuration: false }],
  ["numeric cancellation", { supportsCancellation: 1 }],
  ["numeric region entry", { regions: [1] }],
  ["unsupported region keyword", { regions: "iad1" }],
  ["numeric preferred region", { preferredRegion: 4 }],
  ["boolean preferred region entry", { preferredRegion: [false] }],
  ["string web API flag", { useWebApi: "false" }],
];

// Run against the parent-resolved validator and Orval's existing AJV 8.20.0.
function compatibility(name: string, schema: object, input: unknown, expected: boolean) {
  test(`static-config compatibility: ${name}`, () => {
    const data = structuredClone(input);
    const original = structuredClone(data);
    assert.equal(reference.compile(schema)(data), expected);
    if (expected) assert.equal(validate(schema, data), data);
    else assert.throws(() => validate(schema, data), /^Error: Invalid data$/);
    assert.deepEqual(data, original);
  });
}

for (const [name, data] of validConfigs) {
  compatibility(name, staticConfig.BaseFunctionConfigSchema, data, true);
}
for (const [name, data] of invalidConfigs) {
  compatibility(`reject ${name}`, staticConfig.BaseFunctionConfigSchema, data, false);
}

const sourceCases: Array<{ name: string; source: string; expected?: unknown; error?: RegExp }> = [
  { name: "combined config", source: 'export const config = { runtime: "nodejs22.x", memory: 1024, maxDuration: 60, regions: ["iad1"] };',
    expected: { runtime: "nodejs22.x", memory: 1024, maxDuration: 60, regions: ["iad1"] } },
  { name: "ARM config", source: 'export const config = { architecture: "arm64", maxDuration: "max", supportsCancellation: true };',
    expected: { architecture: "arm64", maxDuration: "max", supportsCancellation: true } },
  { name: "invalid memory", source: 'export const config = { memory: "invalid" };', error: /Invalid data/ },
  { name: "invalid regions", source: "export const config = { regions: [1] };", error: /Invalid data/ },
  { name: "missing config", source: "export default function handler() {}", expected: null },
  { name: "unexported config", source: "const config = { memory: 256 };", expected: null },
  { name: "mutable config", source: "export let config = { memory: 256 };", expected: null },
  { name: "web API config", source: "export const config = { useWebApi: true, preferredRegion: [] };",
    expected: { useWebApi: true, preferredRegion: [] } },
  { name: "nonliteral value", source: "export const config = { memory: Number(256) };", error: /Unhandled type/ },
  { name: "empty config", source: "export const config = {};", expected: {} },
];

for (const [index, fixture] of sourceCases.entries()) {
  test(`static-config compatibility: extract ${fixture.name}`, () => {
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { noLib: true },
    });
    const file = `/static-config-fixture-${index}.ts`;
    project.createSourceFile(file, fixture.source);
    const extract = () => staticConfig.getConfig(project, file);
    if (fixture.error) assert.throws(extract, fixture.error);
    else assert.deepEqual(extract(), fixture.expected);
  });
}

const referenceSchemas = [
  { name: "local fragment", schema: {
    type: "object", properties: { maxDuration: { $ref: "#/definitions/duration" } },
    definitions: { duration: { type: "number" } },
  } },
  { name: "absolute URI fragment", schema: {
    $id: "https://static-config.example.test/absolute.json", type: "object",
    properties: { maxDuration: { $ref: "https://static-config.example.test/absolute.json#/definitions/duration" } },
    definitions: { duration: { type: "number" } },
  } },
  { name: "relative schema URI", schema: {
    $id: "https://static-config.example.test/relative.json", type: "object",
    properties: { maxDuration: { $ref: "duration.json" } },
    definitions: { duration: { $id: "duration.json", type: "number" } },
  } },
  { name: "escaped JSON pointer", schema: {
    type: "object", properties: { maxDuration: { $ref: "#/definitions/duration~1value" } },
    definitions: { "duration/value": { type: "number" } },
  } },
];

for (const { name, schema } of referenceSchemas) {
  compatibility(`${name} accepts number`, schema, { maxDuration: 60 }, true);
  compatibility(`${name} rejects string`, schema, { maxDuration: "60" }, false);
}
