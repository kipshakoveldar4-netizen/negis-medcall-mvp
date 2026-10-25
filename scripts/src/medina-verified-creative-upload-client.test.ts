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
    uploadHandle, token, fileName, fileType: "image", mimeType, fileSize: file.size };
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
  traversal: { storagePath: `${workspaceId}/staged/${nonce}/../original.jpg` },
  wrongExtension: { storagePath: `${workspaceId}/staged/${nonce}/original.png` },
  noHandle: { uploadHandle: undefined }, malformedHandle: { uploadHandle: "u1.bad" }, longHandle: { uploadHandle: "u1." + "x".repeat(2048) },
  noToken: { token: undefined }, emptyToken: { token: " " },
  wrongName: { fileName: "other.jpg" }, wrongMime: { mimeType: "image/png" }, wrongKind: { fileType: "video" },
  wrongSize: { fileSize: 1 }, stringSize: { fileSize: "51" }, missingName: { fileName: undefined },
  wrongEchoWorkspace: { workspaceId: other }, wrongEchoRequestKey: { requestKey: other },
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

for (const path of [`${other}/verified/${nonce}/${digest}.jpg`, `${workspaceId}/verified/${other}/${digest}.jpg`,
  `${workspaceId}/staged/${nonce}/original.jpg`, `${workspaceId}/verified/${nonce}/${digest.slice(1)}.jpg`,
  `${workspaceId}/verified/${nonce}/${"A".repeat(64)}.jpg`, `${workspaceId}/verified/${nonce}/${digest}.png`,
  `${workspaceId}/verified/${nonce}/../${digest}.jpg`, `${workspaceId}/verified/${nonce}/${digest}.jpg/extra`]) {
  test(`unverified storage path refuses even with a matching trusted URL: ${path}`, async () => {
    const f = fixture(); f.asset.storagePath = path;
    f.asset.publicUrl = `${storageOrigin}/storage/v1/object/public/ad-creatives/${path}`;
    await assert.rejects(uploadVerifiedCreativeImage(f.input), /creative_upload_asset_unconfirmed/);
  });
}

for (const wrapper of [null, [], {}, { ready: true }, { publicUrl: "blob:fake", ready: true },
  { asset: null }, { asset: [] }, { item: { id: nonce } }]) {
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
  for (const kind of ["actor", "workspace", "signout", "unmount", "ABA"]) {
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
