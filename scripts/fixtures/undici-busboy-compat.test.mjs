import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const childFlag = "--undici-busboy-child";
const processTimeout = 8_000;
const operationTimeout = 2_000;
const modes = ["baseline", "candidate"];

const crlfParameters = [
  { id: "bare-cr-name", disposition: 'form-data; name="field\rname"', name: "field\rname" },
  { id: "bare-lf-name", disposition: 'form-data; name="field\nname"', name: "field\nname" },
  { id: "bare-cr-filename", disposition: 'form-data; name="file"; filename="file\rname.bin"', filename: "file\rname.bin" },
  { id: "bare-lf-filename", disposition: 'form-data; name="file"; filename="file\nname.bin"', filename: "file\nname.bin" },
  { id: "encoded-cr-name", disposition: "form-data; name*=utf-8''field%0Dname", name: "field\rname" },
  { id: "encoded-lf-name", disposition: "form-data; name*=utf-8''field%0Aname", name: "field\nname" },
  { id: "encoded-cr-filename", disposition: "form-data; name=file; filename*=utf-8''file%0Dname.bin", filename: "file\rname.bin" },
  { id: "encoded-lf-filename", disposition: "form-data; name=file; filename*=utf-8''file%0Aname.bin", filename: "file\nname.bin" },
];

const scenarios = [
  ...[
    "binary-buffered", "binary-chunked", "request-chunked", "base64-chunked",
    "duplicate-fields", "quoted-boundary", "urlencoded-controls", "non-form-controls", "missing-boundary",
    "abort-before", "abort-during-field", "abort-during-file", "truncated-header", "truncated-field",
  ].map(id => ({ id })),
  { id: "truncated-file", expectedFatal: true },
  ...["__proto__", "constructor"].map(header => ({ id: `prototype-header-${header}`, header })),
  ...crlfParameters.map(parameter => ({ id: `crlf-${parameter.id}`, parameter })),
  ...[70, 71, 252, 253, 4096].map(length => ({ id: `boundary-${length}-fragmented-near-match`, length })),
];

function childEnvironment() {
  // Do not inherit preloads, coverage/cache writers, test-runner state, or app credentials.
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function spawnCase(mode, scenario, timeout = processTimeout) {
  return spawnSync(process.execPath, ["--unhandled-rejections=strict", fixturePath, childFlag, mode, scenario], {
    cwd: repoRoot,
    env: childEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 128 * 1024,
  });
}

function assertCleanExit(result) {
  const detail = result.stderr || result.stdout || String(result.error);
  assert.equal(result.error, undefined, detail);
  assert.equal(result.signal, null, detail);
  assert.equal(result.status, 0, detail);
}

function reports(result) {
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Fixture operation timed out")), operationTimeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function multipart(boundary, parts) {
  const chunks = [];
  for (const { disposition, headers = [], body } of parts) {
    chunks.push(Buffer.from([`--${boundary}`, `Content-Disposition: ${disposition}`, ...headers, "", ""].join("\r\n")));
    chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const field = (name, body) => ({ disposition: `form-data; name="${name}"`, body });
const file = (body, headers = []) => ({
  disposition: 'form-data; name="file"; filename="folder/probe.bin"',
  headers: ["Content-Type: application/octet-stream", ...headers], body,
});

async function* chunksOf(bytes, size) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

function loadParser(mode) {
  const rootRequire = createRequire(new URL("../../package.json", import.meta.url));
  const vercelRequire = createRequire(rootRequire.resolve("@vercel/node"));
  const undiciEntry = vercelRequire.resolve("undici");
  const undiciRequire = createRequire(undiciEntry);
  const bodyPath = undiciRequire.resolve("./lib/fetch/body.js");
  const baseline = undiciRequire("@fastify/busboy/package.json");
  const candidate = rootRequire("@fastify/busboy/package.json");
  assert.equal(vercelRequire("undici/package.json").version, "5.29.0");
  assert.equal(baseline.version, "2.1.1");
  assert.equal(candidate.version, "3.2.4");
  const busboyRequire = mode === "baseline" ? undiciRequire : rootRequire;
  const Busboy = busboyRequire("@fastify/busboy");
  const attempts = [];
  const instances = [];
  let substitutions = 0;
  const observedBusboy = new Proxy(Busboy, {
    construct(target, args, newTarget) {
      attempts.push(args[0]);
      const instance = Reflect.construct(target, args, newTarget);
      const observation = { instance, files: [], finished: false };
      instances.push(observation);
      instance.on("file", (...eventArgs) => observation.files.push(eventArgs));
      instance.on("finish", () => { observation.finished = true; });
      // No file-stream error listeners: preserve Undici's real fatal-error behavior.
      return instance;
    },
  });
  const Module = rootRequire("node:module");
  const originalLoad = Module._load;
  assert.equal(rootRequire.cache[undiciEntry], undefined);
  assert.equal(rootRequire.cache[bodyPath], undefined);
  let undici;
  try {
    // Replace only the dependency captured by the installed Fetch body module.
    Module._load = function (id, parent, isMain) {
      if (id === "@fastify/busboy" && parent?.filename === bodyPath) {
        substitutions++;
        return observedBusboy;
      }
      return Reflect.apply(originalLoad, this, [id, parent, isMain]);
    };
    undici = vercelRequire("undici");
  } finally {
    Module._load = originalLoad;
  }
  assert.equal(substitutions, 1);
  assert.equal(rootRequire.cache[undiciEntry].exports, undici);
  assert.ok(rootRequire.cache[bodyPath], "the installed Undici Fetch body module must execute");
  assert.equal(attempts.length, 0, "loading Undici does not construct a multipart parser");
  return {
    undici, Busboy, attempts, instances,
    metadata: {
      undici: "5.29.0", busboy: mode === "baseline" ? baseline.version : candidate.version,
      bodyPath, busboyDirectory: dirname(busboyRequire.resolve("@fastify/busboy/package.json")), substitutions,
    },
  };
}

async function exercise(scenario, mode, parser) {
  const { undici, attempts, instances } = parser;
  const boundary = "undici-compat-fixture";
  const headers = { "Content-Type": `multipart/form-data; boundary=${boundary}` };
  const binary = Buffer.concat([
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    Buffer.from(`\r\n--${boundary.slice(0, -1)}X\r\n${boundary}\r\n`), Buffer.from([0, 255, 128, 13, 10]),
  ]);
  const response = body => new undici.Response(body, { headers });
  const parse = body => bounded(response(body).formData());
  const wire = multipart(boundary, [file(binary)]);
  const assertFile = async (form, expected = binary) => {
    const value = form.get("file");
    // FormData can wrap Undici's File in Node's native File on newer Node releases.
    assert.equal(Object.prototype.toString.call(value), "[object File]");
    assert.equal(value.size, expected.length);
    assert.equal(value.name, "folder/probe.bin", "Undici requests preservePath: true");
    assert.equal(value.type, "application/octet-stream");
    assert.deepEqual(Buffer.from(await bounded(value.arrayBuffer())), expected);
  };

  if (["binary-buffered", "binary-chunked", "request-chunked"].includes(scenario.id)) {
    for (const size of scenario.id === "binary-buffered" ? [0] : [1, 2, 7, 64]) {
      const body = size ? chunksOf(wire, size) : wire;
      const subject = scenario.id === "request-chunked"
        ? new undici.Request("https://fixture.invalid/body", { method: "POST", body, headers, duplex: "half" })
        : response(body);
      await assertFile(await bounded(subject.formData()));
      assert.equal(subject.bodyUsed, true);
    }
  } else if (scenario.id === "base64-chunked") {
    const encoded = binary.toString("base64").match(/.{1,5}/g).join("\r\n");
    for (const encoding of ["base64", "BASE64"]) {
      const body = multipart(boundary, [file(encoded, [`Content-Transfer-Encoding: ${encoding}`])]);
      for (const size of [1, 7, 23]) await assertFile(await parse(chunksOf(body, size)));
    }
  } else if (scenario.id === "duplicate-fields") {
    const body = multipart(boundary, [
      field("tag", "one"), field("empty", ""), file(binary), field("tag", "two"),
      field("__proto__", "ordinary-field"), field("constructor", "also-ordinary"), field("utf8", "caf\u00e9"),
    ]);
    const form = await parse(chunksOf(body, 1));
    assert.deepEqual(form.getAll("tag"), ["one", "two"]);
    assert.equal(form.get("empty"), "");
    assert.equal(form.get("__proto__"), "ordinary-field");
    assert.equal(form.get("constructor"), "also-ordinary");
    assert.equal(form.get("utf8"), "caf\u00e9");
    await assertFile(form);
  } else if (scenario.id === "quoted-boundary") {
    const quoted = "quoted =boundary:42";
    const subject = new undici.Response(chunksOf(multipart(quoted, [field("field", "value")]), 1), {
      headers: { "Content-Type": `multipart/form-data; charset=utf-8; boundary="${quoted}"` },
    });
    assert.deepEqual([...await bounded(subject.formData())], [["field", "value"]]);
  } else if (scenario.id === "urlencoded-controls") {
    const body = Buffer.from("tag=one&tag=two&empty=&space=one+two&escaped=%2B%26%3D&utf8=caf\u00e9");
    for (const size of [0, 1, 7]) {
      const subject = new undici.Response(size ? chunksOf(body, size) : body, {
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      });
      assert.deepEqual([...await bounded(subject.formData())], [
        ["tag", "one"], ["tag", "two"], ["empty", ""], ["space", "one two"], ["escaped", "+&="], ["utf8", "caf\u00e9"],
      ]);
    }
    assert.equal(attempts.length, 0, "URL-encoded forms do not use Busboy");
  } else if (scenario.id === "non-form-controls") {
    new undici.Headers(headers);
    const json = new undici.Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
    assert.deepEqual(await bounded(json.json()), { ok: true });
    for (const contentType of [undefined, "text/plain", "application/json"]) {
      const subject = new undici.Response(Buffer.from("plain"), { headers: contentType ? { "Content-Type": contentType } : {} });
      await assert.rejects(bounded(subject.formData()), { name: "TypeError" });
    }
    assert.equal(attempts.length, 0);
  } else if (scenario.id === "missing-boundary") {
    const subject = new undici.Response(Buffer.from("invalid"), { headers: { "Content-Type": "multipart/form-data" } });
    await assert.rejects(bounded(subject.formData()), error => {
      assert.equal(error.name, "AbortError", "Undici maps Busboy constructor errors to AbortError");
      assert.match(error.message, /boundary/i);
      return true;
    });
    assert.equal(attempts.length, 1);
    assert.equal(instances.length, 0);
  } else if (scenario.id.startsWith("abort-")) {
    const controller = new AbortController();
    const prefix = scenario.id === "abort-during-file"
      ? Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\npartial`)
      : Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n\r\npartial`);
    let dispatches = 0;
    let aborts = 0;
    // Feed a response through real Undici fetch without creating any socket or server.
    const dispatcher = new class extends undici.Dispatcher {
      dispatch(_options, handler) {
        dispatches++;
        handler.onConnect(reason => { aborts++; handler.onError(reason); }, null);
        handler.onHeaders(200, [Buffer.from("content-type"), Buffer.from(headers["Content-Type"])], () => {}, "OK");
        handler.onData(prefix);
        return true;
      }
    }();
    const subject = await bounded(undici.fetch("https://fixture.invalid/abort", { dispatcher, signal: controller.signal }));
    if (scenario.id === "abort-before") controller.abort();
    const rejection = assert.rejects(bounded(subject.formData()), { name: "AbortError" });
    if (scenario.id !== "abort-before") {
      await nextTurn();
      assert.equal(subject.bodyUsed, true, "abort after the actual body parser starts consuming");
      assert.equal(instances.length, 1);
      if (scenario.id === "abort-during-file") assert.equal(instances[0].files.length, 1);
      controller.abort();
    }
    await rejection;
    assert.equal(dispatches, 1);
    assert.equal(aborts, 1);
    assert.equal(attempts.length, scenario.id === "abort-before" ? 0 : 1);
  } else if (scenario.id.startsWith("truncated-")) {
    const safe = multipart(boundary, [field("safe", "complete")]);
    const beginning = safe.subarray(0, safe.length - Buffer.byteLength(`--${boundary}--\r\n`));
    const tail = scenario.id === "truncated-header" ? "Content-Disposition: form-data; name=unfinished"
      : `Content-Disposition: form-data; name="unfinished"${scenario.id === "truncated-file" ? '; filename="a.bin"' : ""}\r\n\r\npartial`;
    const body = Buffer.concat([beginning, Buffer.from(`--${boundary}\r\n${tail}`)]);
    await assert.rejects(parse(chunksOf(body, 7)), error => {
      assert.equal(error.name, "TypeError");
      assert.match(error.message, /unexpected end|terminated early/i);
      return true;
    });
  } else if (scenario.header) {
    const body = multipart(boundary, [{ ...field("field", "value"), headers: [`${scenario.header}: injected`] }]);
    if (mode === "baseline") {
      await assert.rejects(parse(chunksOf(body, 7)), error => {
        assert.equal(error.name, "TypeError");
        assert.match(error.message, /\.push is not a function/);
        return true;
      });
    } else {
      assert.deepEqual([...await parse(chunksOf(body, 7))], [["field", "value"]]);
    }
  } else if (scenario.parameter) {
    const { disposition, name, filename } = scenario.parameter;
    const body = multipart(boundary, [
      field("before", "safe"), { disposition, body: "tainted-value" }, field("after", "safe"),
    ]);
    const form = await parse(chunksOf(body, 1));
    if (mode === "baseline") {
      assert.equal(form.get("before"), "safe");
      assert.equal(form.get("after"), "safe");
      assert.equal([...form].length, 3);
      if (filename) assert.equal(form.get("file").name, filename);
      else assert.equal(form.get(name), "tainted-value");
    } else {
      // Busboy drops the malformed part; it does not reject the entire form.
      assert.deepEqual([...form], [["before", "safe"], ["after", "safe"]]);
    }
  } else if (scenario.length) {
    const longBoundary = "A".repeat(scenario.length);
    const complete = multipart(longBoundary, [field("field", "value")]);
    const fragments = (async function* () {
      yield Buffer.from(`--${longBoundary.slice(0, -1)}`);
      yield Buffer.from("X");
      yield Buffer.from("\r\n");
      yield* chunksOf(complete, 7);
    })();
    const subject = new undici.Response(fragments, {
      headers: { "Content-Type": `multipart/form-data; boundary=${longBoundary}` },
    });
    if (scenario.length <= 252) {
      // Both versions accept some >70-byte boundaries; assert progress, not RFC enforcement.
      assert.deepEqual([...await bounded(subject.formData())], [["field", "value"]]);
    } else {
      await assert.rejects(bounded(subject.formData()), error => {
        assert.equal(error.name, "AbortError");
        assert.match(error.message, /needle cannot have a length bigger than 256/i);
        return true;
      });
      assert.equal(attempts.length, 1);
      assert.equal(instances.length, 0);
    }
  } else {
    assert.fail(`Unknown scenario: ${scenario.id}`);
  }

  for (const options of attempts) {
    assert.equal(options.preservePath, true);
    assert.equal(typeof options.headers["content-type"], "string");
  }
  for (const observation of instances) {
    assert.ok(observation.instance instanceof parser.Busboy);
    for (const args of observation.files) {
      assert.equal(args.length, 5, "Undici consumes Busboy's positional file event contract");
      assert.equal(typeof args[0], "string");
      assert.equal(typeof args[1].on, "function");
      assert.equal(typeof args[2], "string");
      assert.equal(typeof args[3], "string");
      assert.equal(typeof args[4], "string");
    }
    if (!scenario.id.startsWith("abort-") && !scenario.id.startsWith("truncated-") && !(scenario.header && mode === "baseline")) {
      assert.equal(observation.finished, true, "complete forms finish before formData resolves");
    }
  }
  if (!["urlencoded-controls", "non-form-controls", "abort-before"].includes(scenario.id)) {
    assert.ok(attempts.length > 0, "multipart scenarios must reach the real Busboy constructor");
  }
}

async function childMain(mode, id) {
  assert.ok(modes.includes(mode));
  if (id === "watchdog-cpu") {
    process.stdout.write("watchdog-ready\n");
    while (true) { /* Only the parent's OS-level timeout can stop this probe. */ }
  }
  if (id === "watchdog-open-handle") {
    process.stdout.write("watchdog-ready\n");
    setInterval(() => {}, 1_000);
    return;
  }
  if (id === "watchdog-promise") {
    await bounded(new Promise(() => {}));
    assert.fail("an unsettled operation must not pass");
  }
  if (id === "watchdog-rejection") {
    Promise.reject(new Error("Unexpected fixture rejection"));
    await nextTurn();
    assert.fail("strict unhandled rejections must terminate the child");
  }
  const scenario = scenarios.find(item => item.id === id);
  assert.ok(scenario, `Unknown scenario: ${id}`);
  const require = createRequire(import.meta.url);
  let networkAttempts = 0;
  const forbiddenNetwork = () => { networkAttempts++; throw new Error("Network forbidden in Undici compatibility fixture"); };
  globalThis.fetch = forbiddenNetwork;
  require("node:net").Socket.prototype.connect = forbiddenNetwork;
  require("node:net").Server.prototype.listen = forbiddenNetwork;
  require("node:tls").connect = forbiddenNetwork;
  const parser = loadParser(mode);
  const metadata = { mode, scenario: id, ...parser.metadata };
  process.stdout.write(`${JSON.stringify({ phase: "ready", ...metadata })}\n`);
  await exercise(scenario, mode, parser);
  await nextTurn();
  await nextTurn();
  assert.equal(networkAttempts, 0);
  process.stdout.write(`${JSON.stringify({ phase: "result", ...metadata, constructors: parser.attempts.length, networkAttempts })}\n`);
}

if (process.argv[2] === childFlag) {
  await childMain(process.argv[3], process.argv[4]).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  for (const mode of modes) {
    for (const scenario of scenarios) {
      const behavior = scenario.expectedFatal ? "known fatal FileStream error (not a safe rejection)"
        : scenario.parameter ? mode === "baseline" ? "retains CR/LF (baseline characterization)" : "drops malformed part"
        : scenario.header ? mode === "baseline" ? "rejects prototype header with TypeError" : "accepts prototype header without error"
        : "bounded parser behavior";
      test(`${mode}: ${scenario.id}: ${behavior}`, { timeout: processTimeout + 2_000 }, t => {
        const result = spawnCase(mode, scenario.id);
        if (scenario.expectedFatal) {
          assert.equal(result.error, undefined, result.stderr);
          assert.equal(result.signal, null, result.stderr);
          assert.equal(result.status, 1, "characterize the inherited crash; do not mistake it for a safe parser rejection");
          assert.match(result.stderr, /Unhandled 'error' event/);
          assert.match(result.stderr, /FileStream/);
          assert.match(result.stderr, /Part terminated early due to unexpected end of multipart data/);
          const records = reports(result);
          assert.equal(records.length, 1, "a fatal parser case must never emit a success record");
          assert.equal(records[0].phase, "ready");
          assert.equal(records[0].mode, mode);
          assert.equal(records[0].scenario, scenario.id);
          assert.equal(records[0].undici, "5.29.0");
          assert.equal(records[0].busboy, mode === "baseline" ? "2.1.1" : "3.2.4");
          assert.equal(records[0].substitutions, 1);
          assert.ok(result.stderr.includes(records[0].busboyDirectory));
          t.diagnostic("Known Undici 5.29.0 limitation reproduced in isolation: truncated file errors are unhandled. This does not clear an override.");
        } else {
          assertCleanExit(result);
          const records = reports(result);
          assert.deepEqual(records.map(record => record.phase), ["ready", "result"]);
          const completed = records[1];
          assert.equal(completed.mode, mode);
          assert.equal(completed.scenario, scenario.id);
          assert.equal(completed.undici, "5.29.0");
          assert.equal(completed.busboy, mode === "baseline" ? "2.1.1" : "3.2.4");
          assert.equal(completed.substitutions, 1);
          assert.equal(completed.networkAttempts, 0);
        }
      });
    }
  }
  for (const probe of ["watchdog-cpu", "watchdog-open-handle"]) {
    test(`process watchdog kills ${probe} and never counts it as success`, { timeout: 5_000 }, () => {
      const result = spawnCase("candidate", probe, 1_500);
      assert.equal(result.stdout.trim(), "watchdog-ready");
      assert.equal(result.error?.code, "ETIMEDOUT");
      assert.notEqual(result.status, 0);
      assert.throws(() => assertCleanExit(result));
    });
  }
  test("operation watchdog rejects an unsettled promise instead of silently exiting", { timeout: processTimeout + 2_000 }, () => {
    const result = spawnCase("candidate", "watchdog-promise");
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Fixture operation timed out/);
    assert.throws(() => assertCleanExit(result));
  });
  test("unexpected child rejections are fatal and never count as parser success", { timeout: processTimeout + 2_000 }, () => {
    const result = spawnCase("candidate", "watchdog-rejection");
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error: Unexpected fixture rejection/);
    assert.throws(() => assertCleanExit(result));
  });
}
