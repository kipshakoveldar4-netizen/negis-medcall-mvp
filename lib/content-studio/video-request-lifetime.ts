import { performance } from "node:perf_hooks";

export class VideoRequestDeadlineError extends Error {
  readonly status = 503;
  readonly code = "generated_video_request_deadline";
  constructor() { super("Video request outcome is unconfirmed"); }
}

/** One request owns its deadline; retiring it never cancels a committed remote mutation. */
export class VideoRequestLifetime {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly expiresAt: number;
  private readonly deadline: Promise<never>;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(timeoutMs = 50_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 50_000) throw new VideoRequestDeadlineError();
    this.signal = this.controller.signal;
    this.expiresAt = performance.now() + timeoutMs;
    this.deadline = new Promise<never>((_resolve, reject) => {
      this.signal.addEventListener("abort", () => reject(new VideoRequestDeadlineError()), { once: true });
    });
    // A synchronous validation response may retire a request before its first await.
    void this.deadline.catch(() => {});
    this.timer = setTimeout(() => this.close(), timeoutMs);
  }

  assertActive(): void {
    if (!this.signal.aborted && performance.now() >= this.expiresAt) this.close();
    if (this.signal.aborted) throw new VideoRequestDeadlineError();
  }

  remainingMs(cap: number): number {
    this.assertActive();
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 50_000) throw new VideoRequestDeadlineError();
    return Math.min(cap, Math.max(1, Math.floor(this.expiresAt - performance.now())));
  }

  async run<T>(operation: () => T | PromiseLike<T>, stepTimeoutMs?: number): Promise<T> {
    this.assertActive();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const delay = stepTimeoutMs === undefined ? undefined : this.remainingMs(stepTimeoutMs);
      const pending = Promise.resolve().then(() => { this.assertActive(); return operation(); });
      const waits: Array<Promise<T> | Promise<never>> = [pending, this.deadline];
      if (delay !== undefined) {
        waits.push(new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Video step outcome is unconfirmed")), delay);
        }));
      }
      const result = await Promise.race(waits);
      this.assertActive();
      return result;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  close(): void {
    clearTimeout(this.timer);
    this.controller.abort();
  }
}
