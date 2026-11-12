import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function mediaProcessEnvironment(source = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => /^(path|systemroot|windir)$/i.test(key)));
}

function privateEnvironment(directory: string): NodeJS.ProcessEnv {
  const env = mediaProcessEnvironment();
  for (const key of Object.keys(env)) {
    // A relative PATH entry must still refer to the configured binary location,
    // never to the newly writable scratch directory.
    if (/^path$/i.test(key)) env[key] = env[key]!.split(path.delimiter).map(item => {
      const quoted = process.platform === "win32" && /^".*"$/.test(item);
      const entry = quoted ? item.slice(1, -1) : item;
      if (path.isAbsolute(entry)) return item;
      const absolute = path.resolve(entry || ".");
      return quoted ? `"${absolute}"` : absolute;
    }).join(path.delimiter);
  }
  return { ...env, HOME: directory, USERPROFILE: directory, TEMP: directory, TMP: directory, TMPDIR: directory,
    XDG_CACHE_HOME: path.join(directory, "cache"), XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data"), APPDATA: path.join(directory, "config"), LOCALAPPDATA: path.join(directory, "cache") };
}

// This bounds cooperative process lifetimes, not native-code filesystem,
// network, RAM or disk access. Those still need an accepted hosting sandbox.
export function runMediaProcess(binary: string, args: string[], timeoutMs: number): Promise<string> {
  if (!binary || /[\x00-\x1f\x7f]/.test(binary) || !Array.isArray(args)
    || args.some(arg => typeof arg !== "string" || arg.includes("\0"))
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("video_media_process_config_invalid");
  }
  // Preserve explicitly configured relative executables after changing cwd.
  const executable = binary.includes("/") || binary.includes("\\") ? path.resolve(binary) : binary;
  return run(executable, args, timeoutMs);
}

type DirectoryIdentity = { canonical: string; dev: bigint; ino: bigint; birthtimeNs: bigint };

function sameDirectory(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.canonical === b.canonical && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

async function inspectDirectory(directory: string, base: string): Promise<DirectoryIdentity> {
  if (!path.isAbsolute(directory) || path.dirname(directory) !== base || !path.basename(directory).startsWith("medina-media-")) {
    throw new Error("video_media_process_failed");
  }
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || before.ino <= 0n) throw new Error("video_media_process_failed");
  const canonical = await realpath(directory);
  if (canonical !== directory || path.dirname(canonical) !== base) throw new Error("video_media_process_failed");
  const after = await lstat(directory, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev
    || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs) throw new Error("video_media_process_failed");
  return { canonical, dev: after.dev, ino: after.ino, birthtimeNs: after.birthtimeNs };
}

async function removeOwnedDirectory(directory: string, base: string, identity: DirectoryIdentity): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (!sameDirectory(identity, await inspectDirectory(directory, base))) throw new Error("video_media_process_failed");
    try {
      // Retry only after re-attestation, never inside recursive rm itself.
      await rm(identity.canonical, { recursive: true, force: false, maxRetries: 0 });
      return;
    } catch (error) {
      if (attempt >= 3 || !["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      await delay(100 * (attempt + 1));
    }
  }
}

async function run(binary: string, args: string[], timeoutMs: number): Promise<string> {
  let base: string | undefined, directory: string | undefined, identity: DirectoryIdentity | undefined;
  try {
    base = await realpath(path.resolve(os.tmpdir()));
    directory = await mkdtemp(path.join(base, "medina-media-"));
    identity = await inspectDirectory(directory, base);
    await chmod(directory, 0o700);
    for (const name of ["cache", "config", "data"]) await mkdir(path.join(directory, name), { mode: 0o700 });
    const env = privateEnvironment(directory);
    if (!sameDirectory(identity, await inspectDirectory(directory, base))) throw new Error("video_media_process_failed");
    return await new Promise<string>((resolve, reject) => {
      let cleaned = false;
      let failure = "", stdoutBytes = 0, stderrBytes = 0;
      const stdout: Buffer[] = [];
      const child = spawn(binary, args, { windowsHide: true, shell: false, env, cwd: directory,
        stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      const stopOwnedProcess = () => {
        if (cleaned || !child.pid) return;
        cleaned = true;
        try {
          if (process.platform === "win32") {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          } else {
            // detached creates a group owned by this exact invocation. Kill
            // remaining descendants even when the direct decoder has exited.
            process.kill(-child.pid, "SIGKILL");
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = "video_media_process_failed";
        }
      };
      const fail = (code: string) => {
        if (!failure) failure = code;
        stopOwnedProcess();
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const timer = setTimeout(() => fail("video_media_timeout"), timeoutMs);
      child.stdout!.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 256 * 1024) fail("video_media_output_limit");
        else stdout.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 256 * 1024) fail("video_media_output_limit");
      });
      child.stdout!.on("error", () => fail("video_media_process_failed"));
      child.stderr!.on("error", () => fail("video_media_process_failed"));
      child.once("error", () => fail("video_media_process_failed"));
      child.once("exit", stopOwnedProcess);
      process.once("exit", stopOwnedProcess);
      child.once("close", (code) => {
        clearTimeout(timer);
        process.removeListener("exit", stopOwnedProcess);
        if (failure || code !== 0) reject(new Error(failure || "video_media_process_failed"));
        else resolve(Buffer.concat(stdout, stdoutBytes).toString("utf8"));
      });
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    throw new Error(["video_media_timeout", "video_media_output_limit", "video_media_process_failed"].includes(code)
      ? code : "video_media_process_failed");
  } finally {
    if (directory) {
      // Refuse missing, redirected or same-name replacement directories. Do not
      // search for renamed paths or delete a link as though it were our cwd.
      // Re-attestation is not an atomic openat-style/RCE isolation boundary.
      try {
        if (!base || !identity) throw new Error("video_media_process_failed");
        await removeOwnedDirectory(directory, base, identity);
      }
      catch { throw new Error("video_media_process_failed"); }
    }
  }
}
