import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { crc32 } from "node:zlib";

// Run only this file: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-creative-image-resource-limits.test.ts
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(path.join(root, "package.json"));
const ts = requireFromRoot("typescript") as typeof import("typescript");
const helperPath = "lib/crm/creative-image.ts";
const baseline = process.env.MEDINA_CREATIVE_IMAGE_LIMITS_BASELINE;
const source = baseline
  ? execFileSync("git", ["show", `${baseline}:${helperPath}`], { cwd: root, encoding: "utf8" })
  : await readFile(path.join(root, helperPath), "utf8");
const sniffer = await import(pathToFileURL(path.join(root, "lib/content-studio/generation.ts")).href);
type NativeSharp = typeof import("sharp").default;
let native: NativeSharp | undefined;
let decoderError: unknown;
try { native = requireFromRoot("sharp") as NativeSharp; } catch (error) { decoderError = error; }

type Input = { buffer: Buffer; fileName: string; mimeType: string };
type Helper = {
  MAX_CREATIVE_IMAGE_PIXELS: number;
  CreativeImageValidationUnavailable: new () => Error;
  validateCreativeImageBytes(input: Input): Promise<string[]>;
};
type Observation = { methods: string[]; steps: Array<{ method: string; args: unknown[] }>; decodedBytes: number[];
  timeoutSeconds: number[]; timeoutReads: number; imports: string[] };
const observation = (): Observation => ({ methods: [], steps: [], decodedBytes: [], timeoutSeconds: [], timeoutReads: 0, imports: [] });
function sharp(): NativeSharp {
  assert.ok(native, "Native Sharp is unavailable, not an image-validation refusal");
  return native;
}
const nativeOptions = { skip: !native && "Native Sharp unavailable; see the explicit availability test", timeout: 10_000 };

function compile(pixelBudget?: number) {
  let changed = 0;
  const result = ts.transpileModule(source, {
    fileName: helperPath,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    reportDiagnostics: true,
    transformers: pixelBudget === undefined ? undefined : { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "MAX_CREATIVE_IMAGE_PIXELS") {
          changed++;
          return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type,
            ts.factory.createNumericLiteral(pixelBudget));
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  });
  assert.deepEqual(result.diagnostics ?? [], [], "The whole real helper must transpile");
  if (pixelBudget !== undefined) assert.equal(changed, 1, "Only the pixel-budget initializer is scaled for tiny native fixtures");
  return result.outputText;
}

function loadHelper(options: { pixelBudget?: number; observe?: Observation; unavailable?: boolean } = {}): Helper {
  const exports = {} as Helper;
  const instrumented = (buffer: Buffer, inputOptions?: import("sharp").SharpOptions) => {
    // Observation only: all metadata, pixel reads and rejections still come from native Sharp.
    const image = sharp()(buffer, inputOptions);
    const seen = options.observe;
    if (!seen) return image;
    for (const name of ["metadata", "stats", "toColourspace", "ensureAlpha", "raw", "toBuffer"] as const) {
      const method = image[name];
      Object.defineProperty(image, name, { configurable: true, value: (...args: unknown[]) => {
        seen.methods.push(name);
        seen.steps.push({ method: name, args });
        const result = Reflect.apply(method, image, args);
        if (name === "toBuffer" && result && typeof result.then === "function") {
          return result.then((value: unknown) => {
            if (Buffer.isBuffer(value)) seen.decodedBytes.push(value.length);
            return value;
          });
        }
        return result;
      } });
    }
    const timeout = image.timeout.bind(image);
    image.timeout = (value) => {
      seen.methods.push("timeout");
      seen.steps.push({ method: "timeout", args: [value] });
      seen.timeoutSeconds.push(value.seconds);
      const result = timeout(value);
      // This getter proves whether the native worker selected by the helper consumes the option.
      const internal = image as unknown as { options: { timeoutSeconds: number } };
      const seconds = internal.options.timeoutSeconds;
      Object.defineProperty(internal.options, "timeoutSeconds", { configurable: true,
        get() { seen.timeoutReads++; return seconds; } });
      return result;
    };
    return image;
  };
  const decoder = native ? Object.assign(instrumented, native) : instrumented;
  new Script(compile(options.pixelBudget), { filename: helperPath }).runInNewContext({
    exports, Buffer, Error,
    require(name: string) {
      if (name === "../content-studio/generation") return sniffer;
      assert.equal(name, "sharp", "Unexpected production dependency in the isolated helper");
      options.observe?.imports.push(name);
      if (options.unavailable) throw new Error("SYNTHETIC_DECODER_MODULE_UNAVAILABLE");
      sharp();
      return decoder;
    },
  }, { timeout: 1_000 });
  return exports;
}
const helper = loadHelper();
const input = (buffer: Buffer, format: "jpeg" | "png" | "webp"): Input => ({
  buffer, fileName: `native-resource-fixture.${format === "jpeg" ? "jpg" : format}`, mimeType: `image/${format}`,
});
async function accepts(candidate: Input, runtime = helper) {
  const details = await runtime.validateCreativeImageBytes(candidate);
  assert.ok(Array.isArray(details));
  assert.equal(details.length, 0, JSON.stringify(details));
}
async function refuses(candidate: Input, runtime = helper) {
  const details = await runtime.validateCreativeImageBytes(candidate);
  assert.ok(details.length > 0, "A validation refusal must not be confused with native-decoder unavailability");
  assert.ok(details.every((detail) => typeof detail === "string" && detail.length > 0));
}

function chunksPng(buffer: Buffer) {
  const chunks: Array<{ type: string; data: Buffer }> = [];
  for (let offset = 8; offset < buffer.length;) {
    assert.ok(offset + 12 <= buffer.length);
    const size = buffer.readUInt32BE(offset);
    assert.ok(offset + 12 + size <= buffer.length);
    chunks.push({ type: buffer.toString("ascii", offset + 4, offset + 8), data: buffer.subarray(offset + 8, offset + 8 + size) });
    offset += size + 12;
  }
  return chunks;
}
function chunkPng(type: string, data: Buffer) {
  const header = Buffer.alloc(8), checksum = Buffer.alloc(4);
  header.writeUInt32BE(data.length); header.write(type, 4, "ascii");
  checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])));
  return Buffer.concat([header, data, checksum]);
}
function rewritePng(buffer: Buffer, edit: (type: string, data: Buffer) => Buffer) {
  return Buffer.concat([buffer.subarray(0, 8), ...chunksPng(buffer).map(({ type, data }) => chunkPng(type, edit(type, Buffer.from(data))))]);
}

async function animation(frames: number, width = 2, height = 2) {
  assert.ok(frames <= 9 && width * height * frames <= 36, "Fixture generation must stay tiny");
  const pixels = Buffer.alloc(width * height * frames * 3);
  for (let frame = 0; frame < frames; frame++) {
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = (frame * width * height + pixel) * 3;
      pixels[offset] = 20 + frame * 20; pixels[offset + 1] = 40 + frame * 17; pixels[offset + 2] = 60 + frame * 13;
    }
  }
  return sharp()(pixels, { raw: { width, height: height * frames, channels: 3, pageHeight: height } })
    .webp({ lossless: true, delay: Array<number>(frames).fill(20), loop: 0 }).toBuffer();
}

async function apng(options: { advertisedFrames?: number; corruptLast?: boolean } = {}) {
  const frames = await Promise.all(["#e02020", "#2040e0"].map((background) => sharp()({
    create: { width: 2, height: 2, channels: 3, background },
  }).png().toBuffer()));
  const first = chunksPng(frames[0]);
  const header = first.find((chunk) => chunk.type === "IHDR")!;
  const control = Buffer.alloc(8); control.writeUInt32BE(options.advertisedFrames ?? 2);
  const chunks = [chunkPng("IHDR", header.data), chunkPng("acTL", control)];
  let sequence = 0;
  for (let index = 0; index < frames.length; index++) {
    const frame = Buffer.alloc(26);
    frame.writeUInt32BE(sequence++); frame.writeUInt32BE(2, 4); frame.writeUInt32BE(2, 8);
    frame.writeUInt16BE(1, 20); frame.writeUInt16BE(10, 22);
    chunks.push(chunkPng("fcTL", frame));
    const compressed = Buffer.concat(chunksPng(frames[index]).filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
    if (index && options.corruptLast) compressed[2] ^= 0xff;
    if (!index) chunks.push(chunkPng("IDAT", compressed));
    else {
      const number = Buffer.alloc(4); number.writeUInt32BE(sequence++);
      chunks.push(chunkPng("fdAT", Buffer.concat([number, compressed])));
    }
  }
  return Buffer.concat([frames[0].subarray(0, 8), ...chunks, chunkPng("IEND", Buffer.alloc(0))]);
}

const fixtures = native ? (async () => {
  const raw = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255]);
  const encode = () => sharp()(raw, { raw: { width: 3, height: 2, channels: 3 } });
  return { jpeg: await encode().jpeg().toBuffer(), png: await encode().png().toBuffer(), webp: await encode().webp({ lossless: true }).toBuffer() };
})() : undefined;

test("Creative limits: native decoder availability is explicit, not a synthetic SDK or invalid-image result", (t) => {
  assert.ok(!decoderError, "Native Sharp failed to load; decoder tests are skipped rather than misreported as image refusals");
  const decoder = sharp();
  for (const format of ["jpeg", "png", "webp"] as const) {
    assert.equal(decoder.format[format].input.buffer, true, `${format} buffer decoder must be available`);
    assert.equal(decoder.format[format].output.buffer, true, `${format} encoder must be available for in-memory fixtures`);
  }
  t.diagnostic(`Real native Sharp ${decoder.versions.sharp}, libvips ${decoder.versions.vips}; no SDK/storage/network doubles are involved`);
});

for (const format of ["jpeg", "png", "webp"] as const) {
  test(`Creative limits: native small ${format} fully decodes and validation preserves input`, nativeOptions, async () => {
    const buffer = (await fixtures!)[format], before = Buffer.from(buffer);
    const decoded = await sharp()(buffer).raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, 3); assert.equal(decoded.info.height, 2); assert.equal(decoded.data.length, 18);
    await accepts(input(buffer, format));
    assert.deepEqual(buffer, before);
  });
}

for (const format of ["jpeg", "png"] as const) {
  test(`Creative limits: ${format} readable metadata is insufficient when compressed pixels are corrupt`, nativeOptions, async () => {
    const original = (await fixtures!)[format];
    const broken = format === "jpeg" ? original.subarray(0, original.length - 2)
      : rewritePng(original, (type, data) => { if (type === "IDAT") data[2] ^= 0xff; return data; });
    const metadata = await sharp()(broken, { failOn: "warning" }).metadata();
    assert.equal(metadata.width, 3); assert.equal(metadata.height, 2);
    await assert.rejects(sharp()(broken, { failOn: "warning" }).stats());
    await refuses(input(broken, format));
  });
}

test("Creative limits: oversized PNG chunk length is refused before importing Sharp", nativeOptions, async () => {
  const buffer = Buffer.from((await fixtures!).png);
  buffer.writeUInt32BE(0xffff_ffff, 8);
  assert.ok(buffer.length < 1024, "Only the chunk length is oversized, not the allocated fixture");
  const seen = observation();
  await refuses(input(buffer, "png"), loadHelper({ observe: seen }));
  assert.equal(seen.imports.length, 0, "Malformed container framing must be refused before native decoding");
  assert.equal(seen.methods.length, 0);
});

test("Creative limits: PNG without IEND is refused even with all native-encoded IDAT bytes present", nativeOptions, async () => {
  const original = (await fixtures!).png;
  const chunks = chunksPng(original);
  assert.equal(chunks.at(-1)?.type, "IEND");
  const buffer = Buffer.concat([original.subarray(0, 8),
    ...chunks.filter((chunk) => chunk.type !== "IEND").map((chunk) => chunkPng(chunk.type, chunk.data))]);
  assert.ok(chunksPng(buffer).some((chunk) => chunk.type === "IDAT"));
  const seen = observation();
  await refuses(input(buffer, "png"), loadHelper({ observe: seen }));
  assert.equal(seen.imports.length, 0, "A missing terminator is not a native-decoder availability failure");
  assert.equal(seen.methods.length, 0);
});

test("Creative limits: valid ancillary PNG data containing animation chunk names still requires real pixel decode", nativeOptions, async () => {
  const original = (await fixtures!).png;
  const text = chunkPng("tEXt", Buffer.from("Comment\0Literal acTL fcTL fdAT IEND are text, not chunk headers", "ascii"));
  const chunks = chunksPng(original);
  const buffer = Buffer.concat([original.subarray(0, 8), ...chunks.flatMap((chunk, index) => {
    const encoded = chunkPng(chunk.type, chunk.data);
    return index === 0 ? [encoded, text] : [encoded];
  })]);
  const before = Buffer.from(buffer);
  assert.deepEqual(await sharp()(buffer).raw().toBuffer(), await sharp()(original).raw().toBuffer());
  const seen = observation();
  await accepts(input(buffer, "png"), loadHelper({ observe: seen }));
  assert.deepEqual(seen.imports, ["sharp"], "Container screening must not replace native decoder availability checks");
  assert.ok(seen.methods.includes("metadata") && seen.methods.includes("toBuffer"));
  assert.deepEqual(seen.decodedBytes, [3 * 2 * 4], "The actual native output is bounded uchar RGBA");
  assert.deepEqual(buffer, before);
});

test("Creative limits: a bounded PNG header above 40M pixels is refused without a pixel read", nativeOptions, async () => {
  assert.equal(helper.MAX_CREATIVE_IMAGE_PIXELS, 40_000_000);
  const buffer = rewritePng((await fixtures!).png, (type, data) => {
    if (type === "IHDR") { data.writeUInt32BE(8_000); data.writeUInt32BE(5_001, 4); }
    return data;
  });
  assert.ok(buffer.length < 1024, "Only a tiny native-encoded PNG header is changed, never a huge decoded image");
  const metadata = await sharp()(buffer, { limitInputPixels: false }).metadata();
  assert.equal(metadata.width! * metadata.height!, 40_008_000);
  await assert.rejects(sharp()(buffer, { limitInputPixels: helper.MAX_CREATIVE_IMAGE_PIXELS }).metadata(), /pixel limit/i);
  const seen = observation();
  await refuses(input(buffer, "png"), loadHelper({ observe: seen }));
  assert.ok(!seen.methods.includes("stats") && !seen.methods.includes("toBuffer"), "Over-budget geometry must be refused before decoding pixels");
});

test("Creative limits: real animated WebP metadata and statistics include all stacked pages", nativeOptions, async () => {
  const buffer = await animation(3);
  const first = await sharp()(buffer).metadata(), all = await sharp()(buffer, { animated: true }).metadata();
  assert.equal(first.pages, 3); assert.equal(first.height, 2);
  assert.equal(all.width, 2); assert.equal(all.height, 6); assert.equal(all.pageHeight, 2); assert.equal(all.pages, 3);
  const decoded = await sharp()(buffer, { animated: true }).raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.data.length, 36);
  const stats = await sharp()(buffer, { animated: true }).stats();
  assert.equal(stats.channels[0].sum, 4 * (20 + 40 + 60), "Statistics must traverse frames beyond the poster image");
  await accepts(input(buffer, "webp"));
});

test("Creative limits: native WebP input limit applies to aggregate pixels, not just frame dimensions", nativeOptions, async () => {
  const buffer = await animation(3);
  assert.equal((await sharp()(buffer, { limitInputPixels: 8 }).metadata()).height, 2);
  await assert.rejects(sharp()(buffer, { animated: true, limitInputPixels: 8 }).metadata(), /pixel limit/i);
  assert.equal((await sharp()(buffer, { animated: true, limitInputPixels: 12 }).metadata()).height, 6);
});

for (const [frames, width, height, budget, allowed] of [[2, 2, 2, 8, true], [3, 2, 2, 8, false],
  [8, 1, 1, 8, true], [9, 1, 1, 8, false]] as const) {
  test(`Creative limits: whole helper with test-only ${budget}-pixel budget ${allowed ? "accepts" : "rejects"} ${frames} WebP frames of ${width}x${height}`, nativeOptions, async () => {
    const buffer = await animation(frames, width, height);
    assert.equal((await sharp()(buffer, { animated: true }).metadata()).pages, frames);
    const seen = observation(), runtime = loadHelper({ pixelBudget: budget, observe: seen });
    if (allowed) await accepts(input(buffer, "webp"), runtime);
    else {
      await refuses(input(buffer, "webp"), runtime);
      assert.ok(!seen.methods.includes("stats") && !seen.methods.includes("toBuffer"), "Aggregate over-budget pages must not reach full decode");
    }
  });
}

test("Creative limits: WebP full decode rejects corrupt later pixels even when metadata and first frame decode", nativeOptions, async () => {
  const buffer = Buffer.from(await animation(2));
  let frame = 0, corrupted = false;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    if (buffer.toString("ascii", offset, offset + 4) === "ANMF" && frame++ === 1) {
      const nested = offset + 8 + 16;
      assert.equal(buffer.toString("ascii", nested, nested + 4), "VP8L");
      assert.ok(buffer.readUInt32LE(nested + 4) > 6);
      buffer[nested + 8 + 6] ^= 0xff;
      corrupted = true; break;
    }
    offset += 8 + size + size % 2;
  }
  assert.ok(corrupted);
  assert.equal((await sharp()(buffer, { animated: true, failOn: "warning" }).metadata()).pages, 2);
  await sharp()(buffer, { failOn: "warning" }).raw().toBuffer();
  await assert.rejects(sharp()(buffer, { animated: true, failOn: "warning" }).stats());
  await refuses(input(buffer, "webp"));
});

test("Creative limits: PNG decoder availability does not imply APNG all-frame decode availability", nativeOptions, async (t) => {
  const buffer = await apng(), metadata = await sharp()(buffer, { animated: true }).metadata();
  const decoded = await sharp()(buffer, { animated: true }).raw().toBuffer({ resolveWithObject: true });
  if (metadata.pages === 2) {
    assert.equal(metadata.height, 4); assert.equal(decoded.data.length, 24);
    t.diagnostic("Native PNG loader exposes both APNG frames");
  } else {
    assert.equal(metadata.height, 2); assert.equal(decoded.data.length, 12);
    t.diagnostic("Native PNG loader exposes only the APNG poster; animated:true does not validate the other frame");
  }
});

test("Creative limits: bounded APNG advertising more than 40M aggregate pixels cannot be accepted as one PNG frame", nativeOptions, async () => {
  const advertisedFrames = Math.floor(helper.MAX_CREATIVE_IMAGE_PIXELS / 4) + 1;
  const buffer = await apng({ advertisedFrames });
  assert.ok(buffer.length < 1024, "Two native 2x2 payloads only; large frame counts exist solely in the acTL header");
  assert.ok(advertisedFrames * 4 > helper.MAX_CREATIVE_IMAGE_PIXELS);
  const seen = observation();
  await refuses(input(buffer, "png"), loadHelper({ observe: seen }));
  assert.equal(seen.imports.length, 0, "Unsupported animation framing must be refused before Sharp sees its poster");
});

test("Creative limits: whole helper with test-only 4-pixel budget rejects APNG aggregate of 8 pixels", nativeOptions, async () => {
  const buffer = await apng();
  await refuses(input(buffer, "png"), loadHelper({ pixelBudget: 4 }));
});

test("Creative limits: APNG corrupt second-frame pixels cannot hide behind a valid PNG poster", nativeOptions, async () => {
  const buffer = await apng({ corruptLast: true });
  assert.equal((await sharp()(buffer, { failOn: "warning" }).metadata()).width, 2);
  await sharp()(buffer, { failOn: "warning" }).raw().toBuffer();
  await refuses(input(buffer, "png"));
});

test("Creative limits: native statistics and raw decode expose whether the timeout option is consumed", nativeOptions, async (t) => {
  const image = sharp()((await fixtures!).png).timeout({ seconds: 5 });
  const internal = image as unknown as { options: { timeoutSeconds: number } };
  let reads = 0;
  Object.defineProperty(internal.options, "timeoutSeconds", { configurable: true, get() { reads++; return 5; } });
  await image.stats();
  const statsReads = reads;
  await image.raw().toBuffer();
  assert.ok(reads > statsReads, "Positive control: native raw pipeline reads the configured timeout");
  t.diagnostic(`Timeout-option reads: stats=${statsReads}, raw pipeline=${reads - statsReads}; this is binding observation, not a CPU/memory stress test`);
});

test("Creative limits: the helper's full-decode worker must actually consume its configured timeout", nativeOptions, async () => {
  const seen = observation();
  const runtime = loadHelper({ observe: seen });
  await accepts(input((await fixtures!).png, "png"), runtime);
  assert.ok(seen.methods.some((method) => method === "stats" || method === "toBuffer"), "Metadata alone cannot validate pixel data");
  assert.ok(seen.timeoutSeconds.some((seconds) => seconds > 0 && seconds <= 5), "Full decode must configure a bounded timeout");
  assert.ok(seen.timeoutReads > 0, "Calling .timeout() is insufficient when the chosen native stats worker ignores timeoutSeconds");
  assert.equal(seen.methods.includes("stats"), false, "Statistics do not enforce the native pipeline timeout");
  assert.ok(seen.methods.indexOf("timeout") < seen.methods.indexOf("toBuffer"), "The timeout is configured on the base image before decoding");
  assert.equal(seen.steps.find((step) => step.method === "toColourspace")?.args[0], "srgb");
  assert.ok(seen.methods.includes("ensureAlpha"));
  const rawOptions = seen.steps.find((step) => step.method === "raw")?.args[0] as { depth?: string } | undefined;
  assert.equal(rawOptions?.depth, "uchar");
  assert.deepEqual(seen.decodedBytes, [3 * 2 * 4], "The real chained decoder returns at most four 8-bit channels per pixel");
});

test("Creative limits: EXIF orientation changes displayed dimensions without changing pixel count or input bytes", nativeOptions, async () => {
  const buffer = await sharp()((await fixtures!).jpeg).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const before = Buffer.from(buffer), metadata = await sharp()(buffer).metadata();
  assert.equal(metadata.orientation, 6); assert.equal(metadata.width, 3); assert.equal(metadata.height, 2);
  const upright = await sharp()(buffer).autoOrient().raw().toBuffer({ resolveWithObject: true });
  assert.equal(upright.info.width, 2); assert.equal(upright.info.height, 3); assert.equal(upright.data.length, 18);
  await accepts(input(buffer, "jpeg"));
  assert.deepEqual(buffer, before, "Validation is not an orientation rewrite or metadata scrubber");
});

for (const format of ["jpeg", "png", "webp"] as const) {
  test(`Creative limits: ${format} trailing-payload acceptance is characterized, not mistaken for sanitization`, nativeOptions, async () => {
    const original = (await fixtures!)[format], trailer = Buffer.from("\0QA-TRAILING-NOT-PIXELS<synthetic>\0", "utf8");
    const buffer = Buffer.concat([original, trailer]), before = Buffer.from(buffer);
    const reference = await sharp()(original).raw().toBuffer();
    assert.deepEqual(await sharp()(buffer, { failOn: "warning" }).raw().toBuffer(), reference);
    await accepts(input(buffer, format));
    assert.deepEqual(buffer, before, "Ignored trailing bytes are still present after validation");
  });
}

test("Creative limits: loader-only unavailability remains a typed service failure, not native corrupt-input behavior", nativeOptions, async () => {
  const seen = observation(), runtime = loadHelper({ unavailable: true, observe: seen });
  await assert.rejects(runtime.validateCreativeImageBytes(input((await fixtures!).png, "png")), runtime.CreativeImageValidationUnavailable);
  assert.deepEqual(seen.imports, ["sharp"]);
  assert.deepEqual(seen.methods, [], "This is the only loader double; it makes no claim about native decoder behavior");
});
