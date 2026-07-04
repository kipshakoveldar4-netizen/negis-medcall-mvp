import { loadWorkerConfig } from "./config.js";
import { claimNextJob, createSupabase, processJob } from "./worker.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const supabase = createSupabase(config);
  // Log only worker identity and timing — never URLs, paths, or credentials.
  console.log(`[video-worker] started as ${config.workerId}, polling every ${config.pollIntervalMs}ms`);

  let running = true;
  const stop = () => {
    running = false;
    console.log("[video-worker] stop requested, finishing current job");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (running) {
    try {
      const job = await claimNextJob(supabase, config);
      if (job) {
        console.log(`[video-worker] claimed job ${job.id} (attempt ${job.attempts ?? 1})`);
        await processJob(supabase, config, job);
        continue;
      }
    } catch (error) {
      console.error(`[video-worker] poll error: ${error instanceof Error ? error.message : String(error)}`);
    }
    await delay(config.pollIntervalMs);
  }

  console.log("[video-worker] stopped");
}

main().catch((error) => {
  console.error(`[video-worker] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
