import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { lstat, mkdtemp, readFile, mkdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

// Only owned scratch files and native synthetic Node children. No worker main,
// queue, SDK, network, database, real credentials or Docker startup.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const media = await import(pathToFileURL(path.join(root, "artifacts/video-worker/src/ffmpeg.ts")).href);
const marker = "SYNTHETIC_MEDIA_PROCESS_PRIVATE_VALUE";

// Deferred Linux recipe, NOT executed here. Requires a separately approved,
// locally prebuilt image ID of this exact source; never build/pull or start the
// queue to run it. Replace only $APPROVED_LOCAL_IMAGE_ID. No keys, DB/storage
// mounts, host HOME or working tenants (POSIX shell syntax):
// docker run --rm --pull=never --init --network none --read-only --cap-drop ALL \
//   --security-opt no-new-privileges --pids-limit 64 --cpus 1 \
//   --memory 512m --memory-swap 512m --user 1000:1000 \
//   --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
//   --ulimit nofile=128:128 --ulimit fsize=104857600:104857600 \
//   --entrypoint node "$APPROVED_LOCAL_IMAGE_ID" --input-type=module -e '
// import assert from "node:assert/strict"; import fs from "node:fs/promises";
// import {runMediaProcess} from "/app/dist/ffmpeg.js";
// assert.notEqual(process.getuid(),0);
// await assert.rejects(fs.writeFile("/app/probe-write","fixture"),e=>["EROFS","EACCES"].includes(e.code));
// const status=await fs.readFile("/proc/self/status","utf8");
// for(const rule of [/^NoNewPrivs:\s+1$/m,/^Seccomp:\s+2$/m,/^CapEff:\s+0+$/m])assert.match(status,rule);
// for(const [name,max] of [["memory.max",536870912],["pids.max",64]]){
//   const limit=(await fs.readFile("/sys/fs/cgroup/"+name,"utf8")).trim();
//   assert.match(limit,/^\d+$/);assert.ok(Number(limit)<=max);
// }
// const [cpu,period]=(await fs.readFile("/sys/fs/cgroup/cpu.max","utf8")).trim().split(/\s+/).map(Number);
// assert.ok(Number.isFinite(cpu)&&period>0&&cpu/period<=1);
// const scratch=await fs.statfs("/tmp");assert.ok(scratch.blocks*scratch.bsize<=134217728);
// assert.equal(await runMediaProcess(process.execPath,["-e","process.stdout.write(String(process.getuid()!==0))"],5000),"true");
// await assert.rejects(runMediaProcess(process.execPath,["-e","setInterval(()=>{},1000)"],100),{message:"video_media_timeout"});
// console.log("Linux configuration/probe checks passed; adversarial enforcement still pending");
// '
// This probes real configuration, not enforcement. Full acceptance still needs
// descendant exit on success/failure/parent exit, controlled OOM/PID/file-size
// violations and cgroup teardown after a SIGKILL, in disposable containers.
// Dockerfile regexes and the Windows execution tests below prove none of the
// Linux/cgroup/seccomp/enforcement checks. A same-UID decoder can still read
// absolute files or /proc: production secret/network isolation needs hosting
// approval (e.g. a separate secret-free decoder sandbox), not just this recipe.

async function fixture(t: test.TestContext) {
  const parent = await realpath(path.resolve(os.tmpdir()));
  const directory = await mkdtemp(path.join(parent, "medina-media-test-"));
  const canonical = await realpath(directory), original = await lstat(directory, { bigint: true });
  assert.equal(canonical, directory);
  const attest = async () => {
    const current = await lstat(directory, { bigint: true });
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.deepEqual([current.dev, current.ino, current.birthtimeNs], [original.dev, original.ino, original.birthtimeNs]);
    assert.equal(await realpath(directory), canonical);
    assert.equal(path.dirname(canonical), parent);
    assert.ok(path.basename(canonical).startsWith("medina-media-test-"));
  };
  t.after(async () => {
    await attest();
    await writeFile(path.join(directory, "stop"), "stop");
    await delay(100);
    await attest();
    await rm(canonical, { recursive: true, force: true });
  });
  return directory;
}

test("child cannot inherit the service home, cache, loader or credentials", async t => {
  const directory = await fixture(t), home = path.join(directory, "service-home");
  await mkdir(path.join(home, ".aws"), { recursive: true });
  await writeFile(path.join(home, ".aws", "credentials"), marker);
  const keys = ["HOME", "USERPROFILE", "XDG_CACHE_HOME", "NODE_OPTIONS", "FFREPORT", "SUPABASE_SERVICE_ROLE_KEY"];
  const saved = keys.map(key => [key, process.env[key]] as const);
  try {
    for (const key of keys) process.env[key] = key === "HOME" || key === "USERPROFILE" ? home : marker;
    const value = JSON.parse(await media.runMediaProcess(process.execPath, ["-e", String.raw`
      const fs=require('node:fs'), path=require('node:path');
      const home=process.env.HOME||process.env.USERPROFILE;
      process.stdout.write(JSON.stringify({home,cache:process.env.XDG_CACHE_HOME,
        oldCredentials:fs.existsSync(path.join(home||'', '.aws','credentials')),
        leaked:['NODE_OPTIONS','FFREPORT','SUPABASE_SERVICE_ROLE_KEY'].some(k=>process.env[k])}));
    `], 10000));
    assert.notEqual(value.home, home);
    assert.equal(value.oldCredentials, false);
    assert.equal(value.leaked, false);
    assert.ok(value.cache && value.cache.startsWith(value.home + path.sep));
    assert.deepEqual(await readFile(path.join(home, ".aws", "credentials"), "utf8"), marker);
  } finally {
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("each child owns a distinct private cwd/home which is removed before success returns", async t => {
  await fixture(t);
  const run = () => media.runMediaProcess(process.execPath, ["-e", String.raw`
    const fs=require('node:fs');
    process.stdout.write(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,mode:fs.statSync('.').mode&511}));
  `], 10000);
  const first = JSON.parse(await run()), second = JSON.parse(await run());
  assert.notEqual(first.cwd, root);
  assert.notEqual(first.cwd, second.cwd);
  assert.equal(first.home, first.cwd);
  if (process.platform !== "win32") assert.equal(first.mode, 0o700);
  for (const value of [first, second]) await assert.rejects(stat(value.cwd), { code: "ENOENT" });
});

test("concurrent media invocations never share their scratch or cache", async () => {
  const values = await Promise.all(Array.from({ length: 3 }, () => media.runMediaProcess(process.execPath, ["-e",
    "process.stdout.write(JSON.stringify({cwd:process.cwd(),cache:process.env.XDG_CACHE_HOME}))"], 10000)));
  const paths = values.map(value => JSON.parse(value));
  assert.equal(new Set(paths.map(value => value.cwd)).size, 3);
  for (const value of paths) {
    assert.equal(value.cache, path.join(value.cwd, "cache"));
    await assert.rejects(stat(value.cwd), { code: "ENOENT" });
  }
});

for (const substitution of ["junction", "replacement", "rename"] as const) test(`cleanup refuses cwd ${substitution} without deleting a foreign target`, async t => {
  const base = await fixture(t), external = await fixture(t);
  const canary = path.join(external, "canary"), state = path.join(base, "identity.json"), moved = path.join(base, "renamed-original");
  await writeFile(canary, marker);
  const keys = ["TMPDIR", "TEMP", "TMP"] as const, saved = keys.map(key => [key, process.env[key]] as const);
  let allocated: string | undefined;
  try {
    for (const key of keys) process.env[key] = base;
    const program = `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
      const cwd=process.cwd(),base=${JSON.stringify(base)},moved=${JSON.stringify(moved)};
      assert.equal(path.dirname(cwd),base);assert.equal(path.dirname(moved),base);assert.equal(fs.existsSync(moved),false);
      const original=fs.lstatSync(cwd,{bigint:true});assert.ok(original.isDirectory()&&!original.isSymbolicLink());
      assert.equal(fs.realpathSync(cwd),cwd);process.chdir(base);fs.renameSync(cwd,moved);
      ${substitution === "junction" ? `fs.symlinkSync(${JSON.stringify(external)},cwd,${JSON.stringify(process.platform === "win32" ? "junction" : "dir")});`
        : substitution === "replacement" ? `fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'foreign-canary'),${JSON.stringify(marker)});` : ""}
      fs.writeFileSync(${JSON.stringify(state)},JSON.stringify({cwd,dev:String(original.dev),ino:String(original.ino),birthtimeNs:String(original.birthtimeNs)}));
      process.stdout.write('prepared');`;
    let outcome: unknown;
    try { outcome = await media.runMediaProcess(process.execPath, ["-e", program], 10000); } catch (error) { outcome = error; }
    const record = JSON.parse(await readFile(state, "utf8"));
    allocated = record.cwd;
    assert.equal(path.dirname(allocated!), base);
    assert.ok(path.basename(allocated!).startsWith("medina-media-"));
    const original = await lstat(moved, { bigint: true });
    assert.deepEqual([String(original.dev), String(original.ino), String(original.birthtimeNs)], [record.dev, record.ino, record.birthtimeNs]);
    assert.ok(original.isDirectory() && !original.isSymbolicLink());
    assert.equal(await readFile(canary, "utf8"), marker);
    if (substitution === "junction") {
      assert.equal((await lstat(allocated!)).isSymbolicLink(), true, "Unknown replacement link is not ours to remove");
      assert.equal(await realpath(allocated!), external);
    } else if (substitution === "replacement") {
      assert.equal(await readFile(path.join(allocated!, "foreign-canary"), "utf8"), marker, "A same-name replacement is not the captured directory");
    } else await assert.rejects(lstat(allocated!), { code: "ENOENT" });
    assert.ok(outcome instanceof Error);
    assert.equal(outcome.message, "video_media_process_failed");
    assert.equal(outcome.cause, undefined);
    assert.equal(String(outcome).includes(base), false);
  } finally {
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
    // The fixture created this link to its other owned directory. Unlink only
    // that attested link, never recurse through it or an unrecognized target.
    if (substitution === "junction") {
      const record = await readFile(state, "utf8").then(value => JSON.parse(value)).catch(() => null);
      allocated = record?.cwd;
      if (allocated) {
        assert.equal(path.dirname(allocated), base);
        assert.ok(path.basename(allocated).startsWith("medina-media-"));
        const link = await lstat(allocated).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
        if (link) {
          assert.equal(link.isSymbolicLink(), true);
          assert.equal(await realpath(allocated), external);
          await unlink(allocated);
          assert.equal(await readFile(canary, "utf8"), marker);
        }
      }
    }
  }
});

for (const substitute of [false, true]) test(`cleanup re-attests after a simulated busy error (${substitute ? "substituted" : "unchanged"})`, async t => {
  const base = await fixture(t), external = await fixture(t), canary = path.join(external, "canary");
  const moved = path.join(base, "renamed-before-retry");
  await writeFile(canary, marker);
  const keys = ["TMPDIR", "TEMP", "TMP"] as const, saved = keys.map(key => [key, process.env[key]] as const);
  let calls = 0, allocated: string | undefined;
  try {
    const require = createRequire(import.meta.url);
    const source = await readFile(path.join(root, "artifacts/video-worker/src/media-process.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const exports: { runMediaProcess?: typeof media.runMediaProcess } = {}, module = { exports };
    // Only the first rm fault is simulated. All identity/realpath checks, child
    // execution, rename/junction creation and any allowed deletion are real.
    const fakeFs = { ...fsPromises, async rm(target: string, options: Parameters<typeof rm>[1]) {
      assert.equal(path.dirname(target), base);
      assert.ok(path.basename(target).startsWith("medina-media-"));
      allocated = target;
      if (++calls === 1) {
        if (substitute) {
          const original = await lstat(target, { bigint: true });
          assert.ok(original.isDirectory() && !original.isSymbolicLink());
          assert.equal(await realpath(target), target);
          assert.equal(path.dirname(moved), base);
          await rename(target, moved);
          await symlink(external, target, process.platform === "win32" ? "junction" : "dir");
        }
        throw Object.assign(new Error("SYNTHETIC_BUSY"), { code: "EBUSY" });
      }
      assert.equal(substitute, false, "No second removal may be attempted after replacement");
      return rm(target, options);
    } };
    new Function("require", "module", "exports", compiled)((name: string) => name === "node:fs/promises" ? fakeFs : require(name), module, exports);
    for (const key of keys) process.env[key] = base;
    if (substitute) {
      await assert.rejects(exports.runMediaProcess!(process.execPath, ["-e", "process.stdout.write('owned')"], 10000), { message: "video_media_process_failed" });
      assert.equal(calls, 1);
      assert.equal((await lstat(allocated!)).isSymbolicLink(), true);
      assert.ok((await lstat(moved)).isDirectory());
    } else {
      assert.equal(await exports.runMediaProcess!(process.execPath, ["-e", "process.stdout.write('owned')"], 10000), "owned");
      assert.equal(calls, 2);
      await assert.rejects(lstat(allocated!), { code: "ENOENT" });
    }
    assert.equal(await readFile(canary, "utf8"), marker);
  } finally {
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
    if (substitute && allocated) {
      assert.equal(path.dirname(allocated), base);
      assert.equal((await lstat(allocated)).isSymbolicLink(), true);
      assert.equal(await realpath(allocated), external);
      await unlink(allocated);
      assert.equal(await readFile(canary, "utf8"), marker);
    }
  }
});

for (const ending of ["timeout", "stdout", "stderr", "failure"] as const) test(`scratch cleanup and fixed diagnostics after ${ending}`, async t => {
  const directory = await fixture(t), state = path.join(directory, "cwd.json");
  const program = `require('node:fs').writeFileSync(${JSON.stringify(state)},JSON.stringify({cwd:process.cwd()}));console.error(${JSON.stringify(marker)});`
    + (ending === "timeout" ? "setInterval(()=>{},1000)" : ending === "failure" ? "process.exitCode=3"
      : `process.${ending}.write('x'.repeat(300000))`);
  const code = ending === "timeout" ? "video_media_timeout" : ending === "failure" ? "video_media_process_failed" : "video_media_output_limit";
  await assert.rejects(media.runMediaProcess(process.execPath, ["-e", program], 3000), (error: Error) => {
    assert.equal(error.message, code); assert.equal(error.cause, undefined);
    assert.equal(String(error).includes(marker), false); assert.equal(String(error).includes(directory), false); return true;
  });
  const value = JSON.parse(await readFile(state, "utf8"));
  assert.ok(path.basename(value.cwd).startsWith("medina-media-"));
  await assert.rejects(stat(value.cwd), { code: "ENOENT" });
});

test("missing executable and invalid process inputs cannot echo caller values", async () => {
  await assert.rejects(media.runMediaProcess(`no-such-binary-${marker}`, [marker], 3000), { message: "video_media_process_failed" });
  for (const value of [0, -1, 120001, Infinity, NaN, 0.5]) {
    assert.throws(() => media.runMediaProcess(process.execPath, [], value), { message: "video_media_process_config_invalid" });
  }
  assert.throws(() => media.runMediaProcess("bad\0binary", [], 1), { message: "video_media_process_config_invalid" });
  assert.throws(() => media.runMediaProcess(process.execPath, ["bad\0argument"], 1), { message: "video_media_process_config_invalid" });
});

test("native output is byte-bounded while ordinary UTF-8 results stay intact", async () => {
  assert.equal(await media.runMediaProcess(process.execPath, ["-e", "process.stdout.write('\u0410\u0431\u0432')"], 10000), "\u0410\u0431\u0432");
  await assert.rejects(media.runMediaProcess(process.execPath, ["-e", "process.stdout.write('\u0410'.repeat(140000))"], 10000), { message: "video_media_output_limit" });
});

test("relative scratch inputs and outputs keep the real FFmpeg/probe/decode contract", async t => {
  const directory = await fixture(t), input = path.join(directory, "input.mp4");
  await media.runFfmpeg("ffmpeg", ["-version"]);
  await media.runMediaProcess("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "color=c=green:s=64x64:r=5", "-t", "0.2", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", input], 10000);
  const relative = (file: string) => path.relative(process.cwd(), path.join(directory, file));
  const options = { crf: 23, preset: "ultrafast", maxWidth: 64, maxHeight: 64, fps: 5 };
  const args = media.buildTranscodeArgs(relative("input.mp4"), relative("output.mp4"), options);
  assert.equal(args[args.indexOf("-i") + 1], relative("input.mp4"), "Pure builders keep their original argument contract");
  assert.equal(args.at(-1), relative("output.mp4"));
  await media.runFfmpeg("ffmpeg", args);
  assert.equal((await media.probeVideo("ffprobe", relative("output.mp4"), "video/mp4")).width, 64);
  await media.runFfmpeg("ffmpeg", media.buildDecodeArgs(relative("output.mp4")));
  await media.runFfmpeg("ffmpeg", media.buildThumbnailArgs(relative("output.mp4"), relative("thumbnail.jpg")));
  assert.ok((await stat(path.join(directory, "thumbnail.jpg"))).size > 0);
});

test("private HOME is not a filesystem sandbox: explicit same-UID fixture paths remain accessible", async t => {
  const directory = await fixture(t), file = path.join(directory, "explicit-fixture");
  await writeFile(file, marker);
  const result = await media.runMediaProcess(process.execPath, ["-e",
    `process.stdout.write(String(require('node:fs').readFileSync(${JSON.stringify(file)},'utf8')===${JSON.stringify(marker)}))`], 10000);
  assert.equal(result, "true", "OS/UID/proc/credential isolation is an explicit remaining hosting gate");
});

async function treeCase(t: test.TestContext, ending: "timeout" | "success" | "overflow") {
  const directory = await fixture(t), state = path.join(directory, "tree.json");
  const beat = path.join(directory, "beat"), stop = path.join(directory, "stop");
  const grandchild = `const fs=require('node:fs');let n=0;setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0);fs.writeFileSync(${JSON.stringify(beat)},String(++n))},25);setTimeout(()=>process.exit(0),20000)`;
  const program = `const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',windowsHide:true});c.unref();const ready=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(beat)}))return;clearInterval(ready);fs.writeFileSync(${JSON.stringify(state)},JSON.stringify({parent:process.pid,child:c.pid}));${ending === "success" ? "process.stdout.write('done')" : ending === "overflow" ? "process.stdout.write('x'.repeat(300000))" : "setInterval(()=>{},1000)"}},10)`;
  const pending = media.runMediaProcess(process.execPath, ["-e", program], 5000);
  if (ending === "success") assert.equal(await pending, "done");
  else await assert.rejects(pending, (error: Error) => error.message === (ending === "timeout" ? "video_media_timeout" : "video_media_output_limit"));
  const ids = JSON.parse(await readFile(state, "utf8"));
  assert.ok(Number.isSafeInteger(ids.parent) && Number.isSafeInteger(ids.child));
  await delay(150);
  const first = await readFile(beat, "utf8").catch(() => null);
  await delay(150);
  assert.equal(await readFile(beat, "utf8").catch(() => null), first, "No descendant may keep writing after completion");
  assert.throws(() => process.kill(ids.child, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
}

for (const ending of ["timeout", "success", "overflow"] as const) test(`owned descendant lifetime ends on ${ending}`, async t => treeCase(t, ending));

test("explicit parent exit stops its still-running owned media process", async t => {
  const directory = await fixture(t), helper = path.join(directory, "media-process.cjs");
  const beat = path.join(directory, "beat"), state = path.join(directory, "child.json"), stop = path.join(directory, "stop");
  const source = await readFile(path.join(root, "artifacts/video-worker/src/media-process.ts"), "utf8");
  await writeFile(helper, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText);
  const child = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(state)},JSON.stringify({pid:process.pid}));let n=0;setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0);fs.writeFileSync(${JSON.stringify(beat)},String(++n))},25);setTimeout(()=>process.exit(0),20000)`;
  const parent = `const fs=require('node:fs');require(${JSON.stringify(helper)}).runMediaProcess(process.execPath,['-e',${JSON.stringify(child)}],10000).catch(()=>{});const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(beat)})){clearInterval(ready);process.exit(0)}},10);setTimeout(()=>process.exit(9),8000)`;
  await promisify(execFile)(process.execPath, ["-e", parent], { timeout: 12000, windowsHide: true,
    env: { ...media.mediaProcessEnvironment(), TEMP: directory, TMP: directory, TMPDIR: directory } });
  const id = JSON.parse(await readFile(state, "utf8")).pid;
  await delay(150);
  const before = await readFile(beat, "utf8"); await delay(150);
  assert.equal(await readFile(beat, "utf8"), before);
  assert.throws(() => process.kill(id, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
});

test("Docker source selects an unprivileged exec-form runtime, not a Linux acceptance result", async () => {
  const source = await readFile(path.join(root, "artifacts/video-worker/Dockerfile"), "utf8");
  assert.match(source, /^USER\s+(?:node|1000(?::1000)?)\s*$/m);
  assert.match(source, /CMD\s*\["node",\s*"dist\/index\.js"\]/);
  assert.match(source, /COPY\s+--from=build\s+\/app\/dist/);
  assert.doesNotMatch(source.split(/^FROM\s/gm).at(-1)!, /^COPY\s+src\b/m);
});
