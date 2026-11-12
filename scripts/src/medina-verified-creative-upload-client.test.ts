import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Observe the browser contract without pulling its source into the scripts rootDir.
type ObservedVerifiedCreativeAsset = {
  id: string;
  workspaceId: string;
  fileName: string;
  fileType: "image";
  mimeType: string;
  fileSize: number;
  storageBucket: "ad-creatives";
  storagePath: string;
  publicUrl: string;
  status: "uploaded" | "ready";
  [key: string]: unknown;
};
type ObservedVerifiedCreativeUploadInput = {
  workspaceId: string;
  file: Blob;
  fileName: string;
  mimeType: string;
  requestKey: string;
  storageOrigin: string;
  request: (url: string, init: RequestInit) => Promise<{ success: boolean; mode: string; data: unknown }>;
  upload: (bucket: string, path: string, token: string, file: Blob,
    opts: { contentType: string; upsert: false }) => Promise<{ data?: unknown; error?: unknown }>;
  assertCurrent: () => Promise<void>;
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { uploadVerifiedCreativeImage }: {
  uploadVerifiedCreativeImage: (input: ObservedVerifiedCreativeUploadInput) => Promise<ObservedVerifiedCreativeAsset>;
} = await import(pathToFileURL(path.join(root, "artifacts/negis/src/lib/verified-creative-upload.ts")).href);

// The real browser helper, with recording transports only. No SDK, env, storage or HTTP.
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nonce = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const requestKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const storageOrigin = "https://storage.fixture.invalid";
const digest = "1".repeat(64);
const uploadHandle = `u1.c3ludGhldGlj.${"A".repeat(43)}`;
const token = "SYNTHETIC_PRIVATE_UPLOAD_TOKEN";
type Row = Record<string, any>;
type Stage = "signed" | "upload" | "finalize";
const stages: Stage[] = ["signed", "upload", "finalize"];
const envelope = (data: unknown) => ({ success: true, mode: "supabase", data });

function fixture(extension = "jpg", mimeType = "image/jpeg") {
  const fileName = `synthetic.${extension}`;
  const file = new Blob(["synthetic image bytes; the server alone decodes these"], { type: mimeType });
  const path = `${workspaceId}/verified/${nonce}/${digest}.${extension.toLowerCase()}`;
  const asset: Row = { id: nonce, workspaceId, fileName, fileType: "image", mimeType,
    fileSize: file.size + 23, storageBucket: "ad-creatives", storagePath: path,
    publicUrl: `${storageOrigin}/storage/v1/object/public/ad-creatives/${path}`, status: "uploaded" };
  const ticket: Row = { bucket: "ad-creatives-staging", storageBucket: "ad-creatives-staging",
    storagePath: `${workspaceId}/staged/${nonce}/original.${extension.toLowerCase()}`,
    uploadHandle, token, uploadRequired: true, operationId: nonce, requestKey, workspaceId,
    fileName, fileType: "image", mimeType, fileSize: file.size };
  const replies: { signed: any; finalize: any } = { signed: envelope(ticket), finalize: envelope({ asset }) };
  const calls: Array<{ stage: Stage; url?: string; init?: RequestInit; args?: unknown[] }> = [];
  const events: string[] = [];
  let actor = "A", revision = 0, current = true, checks = 0;
  let uploadResult: any = { data: { path: ticket.storagePath }, error: null };
  let guardHook: ((check: number) => void | Promise<void>) | undefined;
  let stageHook: ((stage: Stage) => void | Promise<void>) | undefined;
  const failures: Partial<Record<Stage, unknown>> = {};
  const expired = new Error("synthetic_session_expired");
  const input: ObservedVerifiedCreativeUploadInput = {
    workspaceId, file, fileName, mimeType, requestKey, storageOrigin,
    async assertCurrent() {
      events.push("guard"); checks++;
      if (guardHook) await guardHook(checks);
      // Captured lifetimes must not revive when the actor/workspace switches back.
      if (!current || actor !== "A" || revision !== 0) throw expired;
    },
    async request(url, init) {
      const stage = url.includes("/signed-upload?") ? "signed" : "finalize";
      assert.equal(url, `/api/crm/ad-creatives/${stage === "signed" ? "signed-upload" : "finalize-upload"}?workspaceId=${workspaceId}`);
      calls.push({ stage, url, init }); events.push(stage);
      if (stageHook) await stageHook(stage);
      if (Object.hasOwn(failures, stage)) throw failures[stage];
      return replies[stage];
    },
    async upload(...args) {
      calls.push({ stage: "upload", args }); events.push("upload");
      if (stageHook) await stageHook("upload");
      if (Object.hasOwn(failures, "upload")) throw failures.upload;
      return uploadResult;
    },
  };
  return { input, asset, ticket, replies, calls, events, failures, expired,
    guardHook(hook: typeof guardHook) { guardHook = hook; },
    stageHook(hook: typeof stageHook) { stageHook = hook; },
    uploadResult(value: any) { uploadResult = value; },
    expire(kind = "actor") {
      revision++;
      if (kind === "ABA") { actor = "B"; actor = "A"; }
      else if (kind === "actor") actor = "B";
      else current = false;
    },
  };
}

type ResumeMode = "resume" | "completed";
function resumeFixture(mode: ResumeMode, extension = "jpg", mimeType = "image/jpeg") {
  const f = fixture(extension, mimeType);
  if (mode === "completed") f.replies.signed = envelope({ finalized: true, operationId: nonce, requestKey,
    asset: f.asset, item: { ...f.asset } });
  else { f.ticket.uploadRequired = false; delete f.ticket.token; }
  return f;
}
const resumeModes: ResumeMode[] = ["resume", "completed"];
const resumedStages = (mode: ResumeMode): Stage[] => mode === "completed" ? ["signed"] : ["signed", "finalize"];

for (const [extension, mimeType] of [["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["PNG", "image/png"], ["webp", "image/webp"]]) {
  test(`verified ${extension} uses the exact two POSTs and one create-only SDK upload`, async () => {
    const f = fixture(extension, mimeType);
    const result = await uploadVerifiedCreativeImage(f.input);
    assert.equal(result, f.asset, "Return the actual asset without a fabricated preview or ready state");
    assert.notEqual(result.fileSize, f.input.file.size, "Canonical server encoding may change the output size");
    assert.deepEqual(f.calls.map(call => call.stage), stages);
    assert.deepEqual(f.events, ["guard", "signed", "guard", "guard", "upload", "guard", "guard", "finalize", "guard"]);
    for (const call of [f.calls[0], f.calls[2]]) {
      assert.equal(call.init!.method, "POST"); assert.equal(call.init!.cache, "no-store");
      assert.deepEqual(call.init!.headers, { "Content-Type": "application/json" });
    }
    assert.deepEqual(JSON.parse(String(f.calls[0].init!.body)), {
      fileName: f.input.fileName, fileType: "image", mimeType, fileSize: f.input.file.size, requestKey,
    });
    assert.deepEqual(f.calls[1].args, ["ad-creatives-staging", f.ticket.storagePath, token, f.input.file, { contentType: mimeType, upsert: false }]);
    assert.deepEqual(JSON.parse(String(f.calls[2].init!.body)), { uploadHandle });
    assert.equal(Object.hasOwn(result, "previewUrl"), false);
  });
}

test("either private bucket alias and either actual asset wrapper are supported", async () => {
  for (const alias of ["bucket", "storageBucket"]) {
    const f = fixture(); delete f.ticket[alias];
    f.replies.finalize = envelope({ item: f.asset });
    assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
  }
  const f = fixture(); f.replies.finalize = envelope({ asset: f.asset, item: { ...f.asset } });
  assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
});

for (const outcome of ["returned-error", "thrown-error", "empty-ack"] as const) {
  test(`${outcome} is reconciled by exactly one finalization and never another upload`, async () => {
    const f = fixture();
    if (outcome === "thrown-error") f.failures.upload = new Error(token);
    if (outcome === "returned-error") f.uploadResult({ error: { message: token } });
    if (outcome === "empty-ack") f.uploadResult({});
    assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
    assert.deepEqual(f.calls.map(call => call.stage), stages);
  });
}

test("a stored private object with a lost SDK acknowledgement finalizes once", async () => {
  const f = fixture();
  let stored: Blob | undefined, uploads = 0;
  f.input.upload = async (bucket, path, suppliedToken, file, opts) => {
    uploads++;
    assert.equal(bucket, f.ticket.storageBucket); assert.equal(path, f.ticket.storagePath);
    assert.equal(suppliedToken, token); assert.equal(opts.upsert, false);
    stored = file;
    throw new Error("synthetic_lost_acknowledgement");
  };
  const request = f.input.request;
  f.input.request = async (url, init) => {
    if (url.includes("/finalize-upload?")) assert.equal(stored, f.input.file);
    return request(url, init);
  };
  assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
  assert.equal(uploads, 1);
  assert.deepEqual(f.calls.map(call => call.stage), ["signed", "finalize"]);
});

test("an uncertain SDK result cannot turn failed finalization into local/demo success", async () => {
  const f = fixture(); f.failures.upload = new Error(token);
  f.replies.finalize = { success: false, mode: "supabase", data: { asset: f.asset, publicUrl: f.asset.publicUrl, ready: true } };
  await assert.rejects(uploadVerifiedCreativeImage(f.input), error => {
    assert.match(String(error), /creative_upload_asset_unconfirmed/); assert.equal(String(error).includes(token), false); return true;
  });
  assert.deepEqual(f.calls.map(call => call.stage), stages);
});

for (const phase of ["signed", "finalize"] as const) {
  for (const bad of [null, [], {}, { success: false, mode: "supabase", data: {} },
    { success: "true", mode: "supabase", data: {} }, { success: true, mode: "demo", data: {} },
    { success: true, data: {} }, { success: true, mode: "supabase", data: null }]) {
    test(`${phase} rejects malformed or non-supabase envelope ${JSON.stringify(bad)}`, async () => {
      const f = fixture(); f.replies[phase] = bad;
      await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_(ticket|asset)_unconfirmed/);
      assert.deepEqual(f.calls.map(call => call.stage), phase === "signed" ? ["signed"] : stages);
    });
  }
  for (const patch of [{ success: false }, { success: "true" }, { success: undefined }, { mode: "demo" }, { mode: undefined }]) {
    test(`${phase} refuses invalid envelope flags even when its receipt is otherwise valid: ${JSON.stringify(patch)}`, async () => {
      const f = fixture(); Object.assign(f.replies[phase], patch);
      await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_(ticket|asset)_unconfirmed/);
      assert.deepEqual(f.calls.map(call => call.stage), phase === "signed" ? ["signed"] : stages);
    });
  }
}

const badTickets: Record<string, Row> = {
  publicBucket: { bucket: "ad-creatives", storageBucket: "ad-creatives" }, conflictingAlias: { bucket: "ad-creatives" },
  missingBuckets: { bucket: undefined, storageBucket: undefined },
  wrongWorkspace: { storagePath: `${other}/staged/${nonce}/original.jpg` },
  notStaged: { storagePath: `${workspaceId}/verified/${nonce}/original.jpg` },
  notUuid: { storagePath: `${workspaceId}/staged/not-a-uuid/original.jpg` },
  uuidV1: { storagePath: `${workspaceId}/staged/bbbbbbbb-bbbb-1bbb-8bbb-bbbbbbbbbbbb/original.jpg` },
  uuidV5: { storagePath: `${workspaceId}/staged/bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb/original.jpg` },
  traversal: { storagePath: `${workspaceId}/staged/${nonce}/../original.jpg` },
  wrongExtension: { storagePath: `${workspaceId}/staged/${nonce}/original.png` },
  noHandle: { uploadHandle: undefined }, malformedHandle: { uploadHandle: "u1.bad" }, longHandle: { uploadHandle: "u1." + "x".repeat(2048) },
  noToken: { token: undefined }, emptyToken: { token: " " },
  wrongName: { fileName: "other.jpg" }, wrongMime: { mimeType: "image/png" }, wrongKind: { fileType: "video" },
  wrongSize: { fileSize: 1 }, stringSize: { fileSize: "51" }, missingName: { fileName: undefined },
  wrongEchoWorkspace: { workspaceId: other }, wrongEchoRequestKey: { requestKey: other },
  wrongOperationId: { operationId: other }, malformedOperationId: { operationId: 123 },
  invalidUploadFlag: { uploadRequired: "false" }, nullUploadFlag: { uploadRequired: null },
  invalidFinalizedFlag: { finalized: "true" }, nullFinalizedFlag: { finalized: null },
  publicUrl: { publicUrl: "https://untrusted.fixture.invalid/old.jpg" },
  ready: { ready: true }, readyStatus: { status: "ready" }, embeddedAsset: { asset: {} },
};
for (const [name, patch] of Object.entries(badTickets)) {
  test(`invalid ticket ${name} refuses before SDK or finalization`, async () => {
    const f = fixture(); Object.assign(f.ticket, patch);
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_ticket_unconfirmed/);
    assert.deepEqual(f.calls.map(call => call.stage), ["signed"]);
  });
}

const badAssets: Record<string, Row> = {
  wrongId: { id: other }, wrongWorkspace: { workspaceId: other }, wrongKind: { fileType: "video" },
  wrongName: { fileName: "other.jpg" }, wrongMime: { mimeType: "image/png" },
  noBytes: { fileSize: undefined }, zeroBytes: { fileSize: 0 }, negativeBytes: { fileSize: -1 },
  fractionalBytes: { fileSize: 1.5 }, stringBytes: { fileSize: "42" }, infiniteBytes: { fileSize: Infinity },
  tooManyBytes: { fileSize: 10 * 1024 * 1024 + 1 }, privateBucket: { storageBucket: "ad-creatives-staging" },
  blobUrl: { publicUrl: "blob:synthetic-unverified" }, originLookalike: { publicUrl: "https://storage.fixture.invalid.evil.invalid/file.jpg" },
  insecureUrl: { publicUrl: "http://storage.fixture.invalid/file.jpg" }, credentials: { publicUrl: "https://user@storage.fixture.invalid/file.jpg" },
  urlQuery: { publicUrl: `${storageOrigin}/storage/v1/object/public/ad-creatives/${workspaceId}/verified/${nonce}/${digest}.jpg?download=1` },
  urlFragment: { publicUrl: `${storageOrigin}/storage/v1/object/public/ad-creatives/${workspaceId}/verified/${nonce}/${digest}.jpg#x` },
  invalidStatus: { status: true }, archivedStatus: { status: "archived" }, failedStatus: { status: "failed" },
};
for (const [name, patch] of Object.entries(badAssets)) {
  test(`invalid final asset ${name} cannot produce success`, async () => {
    const f = fixture(); Object.assign(f.asset, patch);
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
    assert.deepEqual(f.calls.map(call => call.stage), stages);
  });
}

test("a finalized asset without an explicit status cannot produce success", async () => {
  const f = fixture(); delete f.asset.status;
  await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
  assert.deepEqual(f.calls.map(call => call.stage), stages);
});

test("an explicitly ready finalized asset is accepted", async () => {
  const f = fixture(); f.asset.status = "ready";
  assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
});

const badPaths = [`${other}/verified/${nonce}/${digest}.jpg`, `${workspaceId}/verified/${other}/${digest}.jpg`,
  `${workspaceId}/staged/${nonce}/original.jpg`, `${workspaceId}/verified/${nonce}/${digest.slice(1)}.jpg`,
  `${workspaceId}/verified/${nonce}/${"A".repeat(64)}.jpg`, `${workspaceId}/verified/${nonce}/${digest}.png`,
  `${workspaceId}/verified/${nonce}/../${digest}.jpg`, `${workspaceId}/verified/${nonce}/${digest}.jpg/extra`];
for (const path of badPaths) {
  test(`unverified storage path refuses even with a matching trusted URL: ${path}`, async () => {
    const f = fixture(); f.asset.storagePath = path;
    f.asset.publicUrl = `${storageOrigin}/storage/v1/object/public/ad-creatives/${path}`;
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
  });
}

const badAssetWrappers = [null, [], {}, { ready: true }, { publicUrl: "blob:fake", ready: true },
  { asset: null }, { asset: [] }, { item: { id: nonce } }];
for (const wrapper of badAssetWrappers) {
  test(`finalization requires a complete actual asset/item: ${JSON.stringify(wrapper)}`, async () => {
    const f = fixture(); f.replies.finalize = envelope(wrapper);
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
  });
}

test("flat public metadata is not an asset receipt, and conflicting wrappers cannot hide behind a good asset", async () => {
  const f = fixture(); f.replies.finalize = envelope({ ...f.asset, ready: true });
  await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
  f.replies.finalize = envelope({ asset: f.asset, item: { ...f.asset, fileSize: 1 } });
  await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
  f.replies.finalize = envelope({ asset: null, item: f.asset });
  await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
});

test("canonical output size can be any positive integer through the 10 MiB boundary", async () => {
  for (const bytes of [1, 10 * 1024 * 1024]) {
    const f = fixture(); f.asset.fileSize = bytes;
    assert.equal((await uploadVerifiedCreativeImage(f.input)).fileSize, bytes);
  }
});

test("metadata and trusted origin are captured once, not retargeted by mutation while awaiting", async () => {
  const f = fixture();
  f.stageHook(stage => {
    if (stage === "signed") Object.assign(f.input, { workspaceId: other, requestKey: other,
      fileName: "replaced.png", mimeType: "image/png", file: new Blob(["replaced"]), storageOrigin: "https://other.fixture.invalid" });
  });
  assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
  assert.deepEqual(f.calls.map(call => call.stage), stages);
  assert.equal((f.calls[1].args![3] as Blob).type, "image/jpeg");
});

for (const origin of ["http://storage.fixture.invalid", `${storageOrigin}/`, `${storageOrigin}/path`,
  `${storageOrigin}?key=value`, `${storageOrigin}#fragment`, "https://user:pass@storage.fixture.invalid", "blob:synthetic", "invalid"]) {
  test(`untrusted/non-origin storage configuration refuses before dispatch: ${origin}`, async () => {
    const f = fixture(); f.input.storageOrigin = origin;
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_request_unconfirmed/);
    assert.deepEqual(f.calls, []);
  });
}

for (const patch of [{ workspaceId: "demo-workspace" }, { requestKey: "" }, { mimeType: "image/svg+xml" },
  { fileName: "wrong.png" }, { fileName: "../image.jpg" }, { fileName: "bad\n.jpg" },
  { fileName: "x".repeat(256) + ".jpg" }, { file: new Blob([]) },
  { file: new Blob(["bytes"], { type: "image/png" }) }, { file: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]) }]) {
  test(`invalid upload input refuses without any transport: ${Object.keys(patch).join(",")}`, async () => {
    const f = fixture(); Object.assign(f.input, patch);
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_request_unconfirmed/);
    assert.deepEqual(f.calls, []);
  });
}

for (const version of [1, 5]) {
  test(`UUID v${version} requestKey refuses before any transport`, async () => {
    const f = fixture(); f.input.requestKey = `dddddddd-dddd-${version}ddd-8ddd-dddddddddddd`;
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_request_unconfirmed/);
    assert.deepEqual(f.calls, []);
  });
}

for (const stage of stages) {
  for (const kind of ["actor", "workspace", "role", "signout", "unmount", "ABA"]) {
    test(`${kind} change while ${stage} awaits refuses further work or publication`, async () => {
      const f = fixture();
      f.stageHook(async reached => { if (reached === stage) { await Promise.resolve(); f.expire(kind); } });
      await assert.rejects(uploadVerifiedCreativeImage(f.input), error => error === f.expired);
      assert.deepEqual(f.calls.map(call => call.stage), stages.slice(0, stages.indexOf(stage) + 1));
    });
  }
}

for (let check = 1; check <= 6; check++) {
  for (const kind of ["signout", "ABA"]) {
    test(`${kind} invalidation in asynchronous guard ${check} blocks its dispatch/result`, async () => {
      const f = fixture();
      f.guardHook(async reached => { if (reached === check) { await Promise.resolve(); f.expire(kind); } });
      await assert.rejects(uploadVerifiedCreativeImage(f.input), error => error === f.expired);
      assert.deepEqual(f.calls.map(call => call.stage), stages.slice(0, Math.floor(check / 2)));
    });
  }
}

for (const stage of stages) {
  test(`rejected ${stage} still runs its post-await guard; upload errors cannot swallow expired authorization`, async () => {
    const f = fixture(); f.failures[stage] = new Error("synthetic_transport_failure");
    f.stageHook(reached => { if (reached === stage) f.expire("ABA"); });
    await assert.rejects(uploadVerifiedCreativeImage(f.input), error => error === f.expired);
    assert.equal(f.events.at(-1), "guard");
    assert.deepEqual(f.calls.map(call => call.stage), stages.slice(0, stages.indexOf(stage) + 1));
  });
}

for (const stage of ["signed", "finalize"] as const) {
  test(`${stage} transport failure is not retried and cannot synthesize an asset`, async () => {
    const f = fixture(), failure = new Error("synthetic_transport_failure"); f.failures[stage] = failure;
    await assert.rejects(uploadVerifiedCreativeImage(f.input), error => error === failure);
    assert.equal(f.events.at(-1), "guard");
    assert.deepEqual(f.calls.map(call => call.stage), stage === "signed" ? ["signed"] : stages);
  });
}

test("legacy private tickets still upload once when uploadRequired and optional echoes are omitted", async () => {
  const f = fixture();
  for (const key of ["uploadRequired", "operationId", "requestKey", "workspaceId"]) delete f.ticket[key];
  f.ticket.signedUrl = "https://unused.fixture.invalid/signed-upload";
  assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
  assert.deepEqual(f.calls.map(call => call.stage), stages);
  assert.equal(f.calls[1].args![2], token);
});

for (const mode of resumeModes) {
  for (const [extension, mimeType] of [["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["PNG", "image/png"], ["webp", "image/webp"]]) {
    test(`${mode} ${extension} uses only its required POSTs without any SDK upload`, async () => {
      const f = resumeFixture(mode, extension, mimeType);
      assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
      assert.deepEqual(f.calls.map(call => call.stage), resumedStages(mode));
      assert.deepEqual(f.events, mode === "completed" ? ["guard", "signed", "guard"]
        : ["guard", "signed", "guard", "guard", "finalize", "guard"]);
      for (const call of f.calls) {
        assert.equal(call.init!.method, "POST"); assert.equal(call.init!.cache, "no-store");
        assert.deepEqual(call.init!.headers, { "Content-Type": "application/json" });
      }
      assert.deepEqual(JSON.parse(String(f.calls[0].init!.body)), {
        fileName: f.input.fileName, fileType: "image", mimeType, fileSize: f.input.file.size, requestKey,
      });
      if (mode === "resume") assert.deepEqual(JSON.parse(String(f.calls[1].init!.body)), { uploadHandle });
      assert.notEqual(f.asset.fileSize, f.input.file.size);
      assert.equal(Object.hasOwn(f.asset, "previewUrl"), false);
    });
  }

  for (const status of ["uploaded", "ready"]) {
    for (const wrapper of ["asset", "item", "both"]) {
      test(`${mode} accepts a complete ${status} ${wrapper} receipt`, async () => {
        const f = resumeFixture(mode); f.asset.status = status;
        const data = mode === "completed" ? f.replies.signed.data : f.replies.finalize.data;
        delete data.asset; delete data.item;
        if (wrapper !== "item") data.asset = f.asset;
        if (wrapper !== "asset") data.item = { ...f.asset };
        assert.deepEqual(await uploadVerifiedCreativeImage(f.input), f.asset);
        assert.deepEqual(f.calls.map(call => call.stage), resumedStages(mode));
      });
    }
  }

  for (const [name, patch] of Object.entries(badAssets)) {
    test(`${mode} refuses invalid asset ${name}`, async () => {
      const f = resumeFixture(mode); Object.assign(f.asset, patch);
      await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
      assert.deepEqual(f.calls.map(call => call.stage), resumedStages(mode));
    });
  }

  for (const storagePath of badPaths) {
    test(`${mode} refuses an unverified hash path even with its matching trusted URL: ${storagePath}`, async () => {
      const f = resumeFixture(mode);
      Object.assign(f.asset, { storagePath, publicUrl: `${storageOrigin}/storage/v1/object/public/ad-creatives/${storagePath}` });
      await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
      assert.deepEqual(f.calls.map(call => call.stage), resumedStages(mode));
    });
  }

  for (const wrapper of badAssetWrappers) {
    test(`${mode} refuses an incomplete asset receipt: ${JSON.stringify(wrapper)}`, async () => {
      const f = resumeFixture(mode);
      if (mode === "completed") f.replies.signed.data = { ...wrapper, finalized: true, operationId: nonce, requestKey };
      else f.replies.finalize = envelope(wrapper);
      await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_(ticket|asset)_unconfirmed/);
      assert.deepEqual(f.calls.map(call => call.stage), resumedStages(mode));
    });
  }

  for (const patch of [{ fileSize: 1 }, { status: "ready" }, { id: other }, { storagePath: `${workspaceId}/verified/${other}/${digest}.jpg` }]) {
    test(`${mode} refuses conflicting asset/item wrappers: ${Object.keys(patch).join(",")}`, async () => {
      const f = resumeFixture(mode);
      const data = mode === "completed" ? f.replies.signed.data : f.replies.finalize.data;
      Object.assign(data, { asset: f.asset, item: { ...f.asset, ...patch } });
      await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
      assert.deepEqual(f.calls.map(call => call.stage), resumedStages(mode));
    });
  }

  test(`${mode} refuses a receipt with no status`, async () => {
    const f = resumeFixture(mode); delete f.asset.status;
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
    assert.deepEqual(f.calls.map(call => call.stage), resumedStages(mode));
  });

  for (const patch of [{ success: false }, { success: "true" }, { mode: "demo" }, { mode: undefined }]) {
    test(`${mode} refuses invalid prepare flags even with an otherwise complete receipt: ${JSON.stringify(patch)}`, async () => {
      const f = resumeFixture(mode); Object.assign(f.replies.signed, patch);
      await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_ticket_unconfirmed/);
      assert.deepEqual(f.calls.map(call => call.stage), ["signed"]);
    });
  }

  test(`${mode} captures metadata, request key, callbacks and query workspace once`, async () => {
    const f = resumeFixture(mode);
    f.stageHook(stage => {
      if (stage === "signed") Object.assign(f.input, { workspaceId: other, requestKey: other,
        fileName: "replaced.png", mimeType: "image/png", file: new Blob(["replaced"]), storageOrigin: "https://other.fixture.invalid",
        request: async () => { throw new Error("retargeted_request"); },
        upload: async () => { throw new Error("retargeted_upload"); },
        assertCurrent: async () => { throw new Error("retargeted_guard"); } });
    });
    assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
    assert.deepEqual(f.calls.map(call => call.stage), resumedStages(mode));
    assert.equal(JSON.parse(String(f.calls[0].init!.body)).requestKey, requestKey);
  });

  for (const stage of resumedStages(mode)) {
    for (const kind of ["actor", "workspace", "role", "signout", "unmount", "ABA"]) {
      test(`${mode} ${kind} change while ${stage} awaits refuses dispatch/publication`, async () => {
        const f = resumeFixture(mode);
        f.stageHook(async reached => { if (reached === stage) { await Promise.resolve(); f.expire(kind); } });
        await assert.rejects(uploadVerifiedCreativeImage(f.input), error => error === f.expired);
        assert.deepEqual(f.calls.map(call => call.stage), resumedStages(mode).slice(0, resumedStages(mode).indexOf(stage) + 1));
        assert.equal(f.events.at(-1), "guard");
      });
    }

    test(`${mode} rejected ${stage} still runs its post-await authorization guard`, async () => {
      const f = resumeFixture(mode); f.failures[stage] = new Error("synthetic_transport_failure");
      f.stageHook(reached => { if (reached === stage) f.expire("ABA"); });
      await assert.rejects(uploadVerifiedCreativeImage(f.input), error => error === f.expired);
      assert.equal(f.events.at(-1), "guard");
      assert.deepEqual(f.calls.map(call => call.stage), resumedStages(mode).slice(0, resumedStages(mode).indexOf(stage) + 1));
    });

    test(`${mode} ${stage} transport failure never retries or synthesizes success`, async () => {
      const f = resumeFixture(mode), failure = new Error("synthetic_transport_failure"); f.failures[stage] = failure;
      await assert.rejects(uploadVerifiedCreativeImage(f.input), error => error === failure);
      assert.equal(f.events.at(-1), "guard");
      assert.deepEqual(f.calls.map(call => call.stage), resumedStages(mode).slice(0, resumedStages(mode).indexOf(stage) + 1));
    });
  }

  for (let check = 1; check <= resumedStages(mode).length * 2; check++) {
    for (const kind of ["role", "signout", "ABA"]) {
      test(`${mode} ${kind} invalidation in asynchronous guard ${check} blocks its dispatch/result`, async () => {
        const f = resumeFixture(mode);
        f.guardHook(async reached => { if (reached === check) { await Promise.resolve(); f.expire(kind); } });
        await assert.rejects(uploadVerifiedCreativeImage(f.input), error => error === f.expired);
        assert.deepEqual(f.calls.map(call => call.stage), resumedStages(mode).slice(0, Math.floor(check / 2)));
      });
    }
  }
}

for (const [name, patch] of Object.entries(badTickets)) {
  if (name === "noToken") continue;
  test(`private resume ${name} refuses before SDK or finalization`, async () => {
    const f = resumeFixture("resume"); Object.assign(f.ticket, patch);
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_ticket_unconfirmed/);
    assert.deepEqual(f.calls.map(call => call.stage), ["signed"]);
  });
}

for (const patch of [{ token }, { token: "" }, { token: null }, { signedUrl: "https://unused.fixture.invalid/signed-upload" },
  { signedUrl: "" }, { signedUrl: null }, { item: {} }, { finalized: true }, { uploadRequired: true }, { uploadRequired: undefined }]) {
  test(`private resume refuses contradictory upload/public receipt: ${JSON.stringify(patch)}`, async () => {
    const f = resumeFixture("resume"); Object.assign(f.ticket, patch);
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_ticket_unconfirmed/);
    assert.deepEqual(f.calls.map(call => call.stage), ["signed"]);
  });
}

test("private resume accepts either bucket alias with absent upload credentials and optional legacy echoes", async () => {
  for (const alias of ["bucket", "storageBucket"]) {
    const f = resumeFixture("resume");
    for (const key of [alias, "operationId", "workspaceId", "requestKey"]) delete f.ticket[key];
    f.ticket.finalized = false;
    assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
    assert.deepEqual(f.calls.map(call => call.stage), ["signed", "finalize"]);
  }
});

test("private resume captures its validated handle and nonce before the finalization guard awaits", async () => {
  const f = resumeFixture("resume");
  f.guardHook(async check => {
    if (check === 3) {
      await Promise.resolve();
      Object.assign(f.ticket, { uploadRequired: true, token, operationId: other, requestKey: other,
        uploadHandle: "u1.changed", storagePath: `${other}/staged/${other}/original.jpg` });
    }
  });
  assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
  assert.deepEqual(f.calls.map(call => call.stage), ["signed", "finalize"]);
  assert.deepEqual(JSON.parse(String(f.calls[1].init!.body)), { uploadHandle });
});

for (const patch of [{ finalized: false }, { finalized: undefined }, { finalized: "true" },
  { operationId: undefined }, { operationId: other }, { operationId: "not-a-uuid" }, { operationId: 123 },
  { operationId: "bbbbbbbb-bbbb-1bbb-8bbb-bbbbbbbbbbbb" }, { operationId: "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb" },
  { requestKey: undefined }, { requestKey: other }, { requestKey: requestKey.toUpperCase() },
  { workspaceId: other }, { uploadRequired: true }, { uploadRequired: "false" }, { uploadRequired: null },
  { token }, { token: null }, { signedUrl: "https://unused.fixture.invalid/signed-upload" },
  { uploadHandle }, { bucket: "ad-creatives-staging" }, { storageBucket: "ad-creatives" },
  { storagePath: `${workspaceId}/staged/${nonce}/original.jpg` }, { publicUrl: "blob:fake" }]) {
  test(`completed prepare refuses a wrong identity or contradictory branch: ${JSON.stringify(patch)}`, async () => {
    const f = resumeFixture("completed"); Object.assign(f.replies.signed.data, patch);
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_(ticket|asset)_unconfirmed/);
    assert.deepEqual(f.calls.map(call => call.stage), ["signed"]);
  });
}

for (const version of [1, 5]) {
  test(`completed prepare refuses a self-consistent UUID v${version} operation nonce`, async () => {
    const f = resumeFixture("completed"), operationId = `bbbbbbbb-bbbb-${version}bbb-8bbb-bbbbbbbbbbbb`;
    const storagePath = `${workspaceId}/verified/${operationId}/${digest}.jpg`;
    Object.assign(f.asset, { id: operationId, storagePath, publicUrl: `${storageOrigin}/storage/v1/object/public/ad-creatives/${storagePath}` });
    Object.assign(f.replies.signed.data, { operationId, item: { ...f.asset } });
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_ticket_unconfirmed/);
    assert.deepEqual(f.calls.map(call => call.stage), ["signed"]);
  });
}

test("completed prepare may explicitly confirm no upload and replay repeatedly without SDK or finalization", async () => {
  const f = resumeFixture("completed"); f.replies.signed.data.uploadRequired = false;
  f.replies.signed.data.workspaceId = workspaceId;
  for (let attempt = 0; attempt < 2; attempt++) assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
  assert.deepEqual(f.calls.map(call => call.stage), ["signed", "signed"]);
});

test("a lost fresh acknowledgement recovers through private resume and completed replay with only one SDK upload", async () => {
  const f = fixture(), unavailable = new Error("synthetic_finalize_unavailable");
  delete f.ticket.uploadRequired;
  f.failures.upload = new Error("synthetic_lost_sdk_acknowledgement");
  f.failures.finalize = unavailable;
  await assert.rejects(uploadVerifiedCreativeImage(f.input), error => error === unavailable);

  delete f.failures.finalize;
  f.ticket.uploadRequired = false; delete f.ticket.token;
  assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);

  f.asset.status = "ready";
  f.replies.signed = envelope({ finalized: true, operationId: nonce, requestKey, asset: f.asset, item: { ...f.asset } });
  assert.equal(await uploadVerifiedCreativeImage(f.input), f.asset);
  assert.deepEqual(f.calls.map(call => call.stage), ["signed", "upload", "finalize", "signed", "finalize", "signed"]);
  const prepares = f.calls.filter(call => call.stage === "signed");
  assert.equal(prepares.length, 3);
  for (const call of prepares) assert.equal(JSON.parse(String(call.init!.body)).requestKey, requestKey);
});

for (const mode of ["fresh", "resume"] as const) {
  for (const version of [1, 5]) {
    test(`${mode} private prepare refuses a self-consistent UUID v${version} operation nonce`, async () => {
      const f = mode === "fresh" ? fixture() : resumeFixture(mode);
      const operationId = `bbbbbbbb-bbbb-${version}bbb-8bbb-bbbbbbbbbbbb`;
      Object.assign(f.ticket, { operationId, storagePath: `${workspaceId}/staged/${operationId}/original.jpg` });
      await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_ticket_unconfirmed/);
      assert.deepEqual(f.calls.map(call => call.stage), ["signed"]);
    });
  }
  for (const patch of [{ operationId: other }, { requestKey: other }, { workspaceId: other }]) {
    test(`${mode} finalization refuses conflicting identity echoes: ${JSON.stringify(patch)}`, async () => {
      const f = mode === "fresh" ? fixture() : resumeFixture(mode);
      Object.assign(f.replies.finalize.data, patch);
      await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
      assert.deepEqual(f.calls.map(call => call.stage), mode === "fresh" ? stages : resumedStages(mode));
    });
  }
}
