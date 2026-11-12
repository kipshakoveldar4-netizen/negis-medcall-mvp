import { createWorkspaceBrowser, stopWorkspaceBrowserBuilds } from './partner-company-workspace-browser.mjs';

// Disposable local demonstration: synthetic SDK, company and read-only HTTP.
const server = await createWorkspaceBrowser();
stopWorkspaceBrowserBuilds();
console.log(JSON.stringify({ url: server.origin, localOnly: true, syntheticData: true, realAccounts: false }));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  stopWorkspaceBrowserBuilds();
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
