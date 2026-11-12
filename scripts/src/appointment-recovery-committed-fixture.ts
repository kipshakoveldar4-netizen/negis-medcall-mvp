import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Owned fixture: real React/hooks + actual appointment actions, API client and serverAuth.
// Only context, SDK session transport and collection delivery are local doubles.
// The caller supplies an owned loopback HTTP server; this is not API/SQL proof.
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const ids = Object.freeze({
  workspace: "00000000-0000-4000-8000-000000002701",
  otherWorkspace: "00000000-0000-4000-8000-000000002702",
  A: "00000000-0000-4000-8000-000000002703",
  B: "00000000-0000-4000-8000-000000002704",
  client: "00000000-0000-4000-8000-000000002705",
  doctor: "00000000-0000-4000-8000-000000002706",
  service: "00000000-0000-4000-8000-000000002707",
  appointment: "00000000-0000-4000-8000-000000002708",
});
export const visit = Object.freeze({
  id: ids.appointment, clientId: ids.client, client: "Synthetic recovery client", phone: "+77000002705",
  whatsapp: "+77000002705", service: "Synthetic service", serviceId: ids.service,
  serviceItems: [{ serviceId: ids.service, name: "Synthetic service", durationMinutes: 45, priceMinor: 120000 }],
  doctor: "Synthetic doctor", doctorId: ids.doctor, startsAt: "2026-10-25T09:00:00.000Z",
  durationMinutes: 45, priceMinor: 120000, status: "scheduled", notes: "Synthetic private recovery draft", source: "Synthetic local test",
});
const frontend = path.join(root, "artifacts/negis");
const frontendRequire = createRequire(path.join(frontend, "package.json"));
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const esbuild = createRequire(frontendRequire.resolve("vite/package.json"))("esbuild") as {
  build(options: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>;
  stop(): void;
};

async function actualSlice(clinicTimeZone: "UTC" | "Asia/Almaty") {
  const source = await readFile(path.join(frontend, "src/pages/AppointmentsPage.tsx"), "utf8");
  const ast = ts.createSourceFile("AppointmentsPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const page = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "AppointmentsPage") as import("typescript").FunctionDeclaration;
  assert.ok(page?.body);
  const names = (name: import("typescript").BindingName): string[] => ts.isIdentifier(name) ? [name.text]
    : name.elements.flatMap(item => ts.isBindingElement(item) ? names(item.name) : []);
  const has = (node: import("typescript").Statement, name: string) =>
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) ? node.name?.text === name
      : ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names(item.name).includes(name));
  const select = (statements: readonly import("typescript").Statement[], wanted: string[]) => {
    const selected = new Set<import("typescript").Statement>();
    for (const name of wanted) {
      const matches = statements.filter(node => has(node, name));
      assert.equal(matches.length, 1, `One actual declaration for ${name}`);
      selected.add(matches[0]);
    }
    return statements.filter(node => selected.has(node)).map(node => node.getText(ast)).join("\n");
  };
  const helpers = select(ast.statements, ["activeStatuses", "normalizeStatus", "getAppointmentStatusLabel", "pad", "toDateKey", "toTimeKey",
    "toLocalDate", "toStartsAt", "dateKeyFromStartsAt", "timeKeyFromStartsAt", "readString", "readNumber", "asRecord",
    "appointmentFromApi", "appointmentToApi", "safeJson", "defaultForm", "formFromAppointment", "formServiceItems", "appointmentFromForm",
    "SlotTakenError", "ServerRefusalError", "APPOINTMENT_ERROR_TEXTS", "refusalText", "conflictFromBody", "OutsideScheduleError",
    "scheduleRefusalFromBody", "describeSchedule", "describeConflict", "appointmentInterval", "AppointmentAccessRefusalError",
    "AppointmentCreateRecoveryError", "appointmentAttemptStorage", "isUuidText"]);
  const state = select(page.body.statements, ["userRole", "terms", "selectedDate", "modalOpen", "editingId", "form", "clientMatches",
    "clientSearchAttempted", "remoteVisitHistory", "conflictMessage", "saving", "submitLock", "createAttempt", "serviceSearch",
    "doctorSearch", "scheduleMessage", "prefillLeadRef", "restoredCreateScope", "unconfirmedCreate", "createRecoveryError", "createRecoveryRead"]);
  const start = page.body.statements.findIndex(node => has(node, "mutationWorkspaceId"));
  const end = page.body.statements.findIndex(node => has(node, "discardRefusedAppointment"));
  assert.ok(start >= 0 && end > start);
  const scope = page.body.statements.slice(start, end + 1).map(node => node.getText(ast)).join("\n");
  const actions = select(page.body.statements, ["unsavedFromBody", "warnAboutUnsaved", "patchAppointment", "updateAppointmentStatus",
    "findConflict", "submitForm", "createAppointment", "openEdit"]);
  const imports = ast.statements.filter(ts.isImportDeclaration).filter(node => {
    const module = (node.moduleSpecifier as import("typescript").StringLiteral).text;
    return ["react", "@/lib/api", "@/lib/appointmentCreateAttempt", "@/lib/appointmentClient", "@/lib/clinicDay", "@/lib/clinicDateTime",
      "@/lib/dayGrid", "../../../../lib/crm/appointment-services", "../../../../lib/crm/appointment-capacity", "../../../../lib/vertical/terms",
      "@/lib/leadPipeline", "@/lib/phone"].includes(module);
  }).map(node => node.getText(ast)).join("\n");
  return `${imports}
import {useSyncExternalStore} from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
import {fixture,useAuth,hasSupabaseFrontendEnv,supabase,readCurrentWorkspaceId,isRealWorkspace,toast,markLeadBooked} from 'appointment-committed-fake';
${helpers}
const todayKeyAtLoad='2026-10-25',clinicTimeZone=${JSON.stringify(clinicTimeZone)},clinicTimeZoneReady=true;
const activeCatalog=[],activeDoctors=[],directory={items:[]};
const addItem=()=>{throw Error('Demo mutation forbidden');};
function RecoverySlice(){
 const [appointmentItems,writeItems]=useState([]);
 const setItems=update=>{if(fixture.holdCollection && typeof update==='function'){fixture.collectionQueue.push(()=>writeItems(update));}else writeItems(update);};
 ${state}
 ${scope}
 ${actions}
 useLayoutEffect(()=>{fixture.view={items,form,selectedDate,modalOpen,saving,unconfirmedCreate,createRecoveryError,createRecoveryRead,
    createAttempt,mutationScope,submitLock,isCurrentMutationScope,submitForm,createAppointment,setForm,setModalOpen,setEditingId,
    setCreateRecoveryRead,setItems,prefillLeadRef,openEdit};});
 return <main><output id="rows">{JSON.stringify(items)}</output>{modalOpen?<form onSubmit={e=>{e.preventDefault();void submitForm();}}>
   <input aria-label="Client" value={form.client} readOnly/><input aria-label="Phone" value={form.phone} readOnly/>
   <textarea aria-label="Notes" value={form.notes} readOnly/><button type="submit">Reconcile</button></form>:null}
   <output id="recovery-error">{createRecoveryError}</output></main>;
}
let app;
fixture.mount=()=>{app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<RecoverySlice/>));};
fixture.unmount=()=>flushSync(()=>app.unmount());
fixture.draft=()=>flushSync(()=>{fixture.view.setForm(formFromAppointment(${JSON.stringify(visit)},clinicTimeZone));fixture.view.setEditingId(null);fixture.view.setModalOpen(true);});
fixture.edit=item=>{const current=appointmentFromApi(item);flushSync(()=>fixture.view.setItems([current]));flushSync(()=>fixture.view.openEdit(current));};
fixture.refreshItems=item=>flushSync(()=>fixture.view.setItems([appointmentFromApi(item)]));
fixture.start=()=>{const task={done:false,error:null};fixture.tasks.push(task);task.promise=fixture.view.submitForm().then(()=>{task.done=true;},e=>{task.error=e.message;task.done=true;});};
fixture.capture=()=>{const action=fixture.view.submitForm;return()=>{const task={done:false,error:null};fixture.tasks.push(task);task.promise=action().then(()=>{task.done=true;},e=>{task.error=e.message;task.done=true;});};};
fixture.snapshot=()=>({items:fixture.view.items,form:fixture.view.form,selectedDate:fixture.view.selectedDate,modalOpen:fixture.view.modalOpen,saving:fixture.view.saving,
 uncertain:fixture.view.unconfirmedCreate,error:fixture.view.createRecoveryError,locked:fixture.view.submitLock.current,
 attempt:fixture.view.createAttempt.current?{requestKey:fixture.view.createAttempt.current.requestKey,payload:fixture.view.createAttempt.current.payload,
 actorId:fixture.view.createAttempt.current.actorId,workspaceId:fixture.view.createAttempt.current.workspaceId,uncertain:fixture.view.createAttempt.current.uncertain}:null,
 receipts:Object.keys(sessionStorage).filter(k=>k.startsWith('medina_appointment_create_attempt')).map(k=>[k,sessionStorage.getItem(k)]),
 successes:[...fixture.successes],errors:[...fixture.errors],handoffs:[...fixture.handoffs],tokens:fixture.tokens.length,tasks:fixture.tasks.map(t=>({done:t.done,error:t.error})),
 sdkListeners:fixture.sdkListeners.size,phone:document.querySelector('[aria-label="Phone"]')?.value??null});
fixture.mount();window.__appointmentRecovery=fixture;
`;
}

const mocks = `
import {useSyncExternalStore} from 'react';import {flushSync} from 'react-dom';
const ids=${JSON.stringify(ids)};
let context={vertical:'clinic',userRole:'owner',user:{id:ids.A},clinicId:ids.workspace,isLoading:false,isSigningOut:false,isDemoMode:false,isImpersonation:false};
let actor=ids.A,selectedWorkspace=ids.workspace;const listeners=new Set(),sdkListeners=new Set();
export const fixture={tokens:[],tasks:[],successes:[],errors:[],warnings:[],handoffs:[],sdkListeners,holdToken:false,holdCollection:false,collectionQueue:[],
 patch(value){flushSync(()=>{context={...context,...value};for(const fn of listeners)fn();});},
 actor(value){this.raw(value);this.patch({user:{id:value}});},
 raw(value,event='SIGNED_IN'){actor=value;for(const fn of sdkListeners)fn(event,value?{user:{id:value}}:null);},
 aba(){flushSync(()=>{this.raw(ids.B);this.raw(ids.A);});},
 workspace(value){selectedWorkspace=value;this.patch({clinicId:value});},
 role(value){this.patch({userRole:value});},
 refresh(){this.raw(actor,'TOKEN_REFRESHED');},
 releaseToken(index){this.tokens[index].release();},
 releaseCollection(){const queue=this.collectionQueue.splice(0);flushSync(()=>{for(const fn of queue)fn();});},
 tick:()=>new Promise(resolve=>setTimeout(resolve,20))};
export function useAuth(){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>context);}
export const hasSupabaseFrontendEnv=true;
export const supabase={auth:{onAuthStateChange(fn){sdkListeners.add(fn);return{data:{subscription:{unsubscribe(){sdkListeners.delete(fn);}}}};},
 async getSession(){const captured=actor;let release;const wait=new Promise(resolve=>{release=resolve;});fixture.tokens.push({actor:captured,release});
  if(fixture.holdToken)await wait;return{data:{session:{user:{id:captured},access_token:'synthetic-'+captured}},error:null};}}};
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};
export const readCurrentWorkspaceId=()=>selectedWorkspace;
export const isRealWorkspace=()=>true;
export const isSignOutPending=()=>false;export const getSignOutRevision=()=>0;
export const markLeadBooked=id=>fixture.handoffs.push(id);
export const toast={success:message=>fixture.successes.push(message),error:message=>fixture.errors.push(message),warning:message=>fixture.warnings.push(message)};
`;

export async function recoveryBundle(options: { jwtLikeTokens?: boolean; clinicTimeZone?: "UTC" | "Asia/Almaty" } = {}) {
  const clinicTimeZone = options.clinicTimeZone ?? "UTC";
  assert.ok(["UTC", "Asia/Almaty"].includes(clinicTimeZone));
  const result = await esbuild.build({ stdin: { contents: await actualSlice(clinicTimeZone), resolveDir: path.join(frontend, "src/pages"),
    sourcefile: "appointment-committed-slice.tsx", loader: "tsx" }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.BASE_URL": '"/"', "import.meta.env.VITE_API_BASE_URL": '""' },
    plugins: [{ name: "owned-appointment-recovery", setup(build: any) {
      build.onResolve({ filter: /^(appointment-committed-fake|@\/lib\/supabase|@\/lib\/authSignOut)$/ }, () => ({ path: "mocks", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        // Only synthetic transport data changes; real server authentication still
        // validates the token against the owned Auth boundary in native tests.
        contents: options.jwtLikeTokens ? mocks.replace("'synthetic-'+captured", "'owned.'+captured+'.signature'") : mocks,
        loader: "tsx", resolveDir: frontend,
      }));
      build.onResolve({ filter: /^@\// }, async (args: { path: string }) => {
        const base = path.join(frontend, "src", args.path.slice(2));
        const file = [base + ".ts", base + ".tsx"].find(existsSync); assert.ok(file, args.path); return { path: file };
      });
    } }],
  });
  return result.outputFiles[0].text;
}
export const stopRecoveryBundler = () => esbuild.stop();

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function ownedRecoveryBrowser(origin: string, options: { settleTimeoutMs?: number } = {}) {
  const parsed = new URL(origin);
  assert.equal(parsed.hostname, "127.0.0.1"); assert.equal(parsed.protocol, "http:");
  const settleTimeoutMs = options.settleTimeoutMs ?? 4500;
  assert.ok(Number.isInteger(settleTimeoutMs) && settleTimeoutMs >= 4500 && settleTimeoutMs <= 30000);
  const browserPath = [process.env.MEDINA_TEST_BROWSER_PATH, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
    .find(value => value && existsSync(value));
  assert.ok(browserPath, "An existing local Chromium executable is required; no install/download fallback");
  const profile = await mkdtemp(path.join(tmpdir(), "medina-appointment-committed-owned-"));
  const child = spawn(browserPath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions",
    "--disable-sync", "--disable-component-update", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { windowsHide: true, stdio: "ignore", env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "HOME", "DISPLAY"].includes(key))) });
  const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  let ws: WebSocket | undefined, seq = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const exceptions: unknown[] = [], requests: string[] = [];
  const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(`Owned browser timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer }); ws!.send(JSON.stringify({ id, method, params }));
  });
  const close = async () => {
    if (ws?.readyState === WebSocket.OPEN) await call("Browser.close").catch(() => {});
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(3000)]); }
    ws?.close(); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Owned browser closed")); } pending.clear();
    assert.equal(path.dirname(profile), path.resolve(tmpdir()));
    assert.ok(path.basename(profile).startsWith("medina-appointment-committed-owned-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  try {
    let port = "";
    for (let i = 0; i < 250; i++) {
      assert.equal(child.exitCode, null, "Owned browser stays live during startup");
      try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]; } catch {}
      if (/^\d+$/.test(port)) break; await delay(80);
    }
    assert.match(port, /^\d+$/);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = targets.find(value => value.type === "page"); assert.ok(page);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
        if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
        return;
      }
      const item = pending.get(message.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.error) item.reject(Error(JSON.stringify(message.error))); else item.resolve(message.result);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws!.close(); reject(Error("Owned websocket startup timed out")); }, 10_000);
      ws!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws!.addEventListener("error", () => { clearTimeout(timer); reject(Error("Owned websocket failed")); }, { once: true });
    });
    await call("Network.enable"); await call("Runtime.enable");
    const evaluate = async <T = any>(body: string): Promise<T> => {
      const result = await call("Runtime.evaluate", { expression: `(async()=>{const f=window.__appointmentRecovery;${body}})()`, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const waitFor = async (expression: string) => {
      for (let i = 0; i < Math.ceil(settleTimeoutMs / 30); i++) { if (await evaluate<boolean>(`return !!(${expression});`)) return; await delay(30); }
      const state = await evaluate("return f?.snapshot?.();");
      throw Error(`Owned fixture did not settle: ${expression}; ${JSON.stringify({ exceptions, state })}`);
    };
    const load = async () => { await call("Page.navigate", { url: origin }); await waitFor("f && f.view && f.view.isCurrentMutationScope()"); };
    await load();
    const viewport = async (width: number, height: number) => {
      assert.ok(Number.isInteger(width) && width >= 320 && width <= 2560 && Number.isInteger(height) && height >= 480 && height <= 2000);
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    };
    const screenshot = async () => {
      const result = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      return Buffer.from(result.data as string, "base64");
    };
    return { evaluate, waitFor, load, close, requests, exceptions, viewport, screenshot };
  } catch (error) { await close(); throw error; }
}
