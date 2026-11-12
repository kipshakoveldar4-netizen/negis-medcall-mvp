# Generated Video: One Request Lifetime And Conservative Recovery

G5-C59, 26 October 2026, base 7acd4e5. Local implementation/acceptance only.
No Preview/Production change, cloud SQL/configuration, provider request, real
account/data, Baspana, salon, WhatsApp, advertisement, paid generation or expense.

## Required Result

C58 bounded provider metadata only. Inspection found 20-second SDK bounds and
two identical RPC attempts inside a route with several authorization, quota,
provider, upload and proof waits. Those separate limits could exceed Vercel's
unchanged 60-second cap; quota and accounting also lacked a total caller bound.
Racing the whole handler alone would return early while its continuations could
still dispatch, queue or write another response. The required result is one
request-owned wait budget plus fences on subsequent application actions, not
just a short timeout response or a larger platform duration.

## Implementation

- Video POST and GET now own a 50-second monotonic lifetime from the initial
  authorization through their response. It has one retirement signal, remaining
  time, pre-dispatch/post-result checks and bounded stage waits. A later stage or
  identical RPC retry cannot reset the total deadline. No env/payload override
  or Vercel duration change was added. The smaller constructor override is internal.
- The original authorization registry, permissions, purpose checks and current
  actor checks remain. A guarded response preserves native method binding and
  chaining while preventing late authorization/controller code from writing
  headers/body after retirement. Already-sent responses are not sent twice.
- The same lifetime accompanies native workflow configuration: SDK reads,
  bucket checks, identical-nonce RPCs, private upload and every private/public
  proof wait share it. Timeout does not claim that a remote mutation rolled back.
  A retired scope cannot admit another application SDK/RPC/upload step.
- Actual quota reservation checks lifetime around the plan read and reserve
  RPC separately. A late plan read cannot start a quota write. Only video opts
  into this optional caller lifetime; existing image/text behavior is unchanged.
  Video completion is bounded before/after the accounting call and cannot be
  newly dispatched after retirement.
- Provider metadata and MP4 download receive both the remaining stage time and
  retirement signal. A final fetch-boundary monotonic check precedes transport.
  Ignored cancellation is bounded by a rejection race; late bodies are cleaned
  up best effort and cannot bind/link/queue/promote anything. Existing stage
  byte/MIME/receipt/redirect protections remain.
- Request-aborted and response-close events retire the same lifetime. A broken
  transport gets no attempted second response. Listeners/timers are removed on
  every exit. A normal completed response still works with existing res chaining.

After an uncertain deadline, an intact transport receives a private/no-store
503 with a stable generated_video_request_deadline code and no identity, handle
or file. It instructs verification of the same intent, not a new paid render.
ContentStudio's existing 5xx key preservation keeps the paid request receipt.
No new endpoint/API file, database migration, rate, role or commercial rule exists.

## Evidence And Recovery Boundaries

Actual controller/provider/workflow code runs with explicit Auth, quota, SDK and
network doubles. The actual quota module also has a separate late-plan test.
These are not real Supabase/Auth/Storage/native-worker acceptance.

The bounded matrix includes:

- Initial auth allow/late denial, current-actor wait, bucket lookup and quota
  reservation: no downstream dispatch or late second response after expiration.
- Auth 19s + quota 19s leaves only 12s for begin. Its late backend commit may
  retain dispatching/nonce, but cannot reach a provider or start another RPC.
- A provider-linked job followed by hung accounting: no failed-render/refund
  claim, and a fresh same-key request returns its original handle without quota
  reservation or paid generation.
- Late immutable private upload: its raw bytes may commit after the response,
  but no queue transition occurs from the retired caller. A fresh free GET
  proves the exact object and queues it without another upload or render.
- Private proof and provider MP4 header/body waits: abort at the remaining total
  deadline, no input admission or premature public receipt from late bytes.
- Late finalization may commit once; its retired caller exposes nothing. A new
  free poll verifies the committed native receipt and returns the same handle.
- Expiry immediately after a successful response never writes a second response.
  Request abort/response close during auth, and disconnect during accepted-job
  accounting, also stop follow-on actions without quota refund or duplicate job.
- Lifetime unit cases cover monotonic expiry without a timer turn, retirement
  before the dispatch microtask, remaining-time consumption, bounded identical
  retry and invalid budgets before dispatch.

Final source acceptance:

- Request budget/controller/workflow: 19/19. Lifetime units: 6/6. The separate
  existing quota set is 8/8; the combined scoped run is 33/33, not 33 new tests.
- Expanded media/content/quota/replay/terminal-failure/download set: 1358/1358
  after the final runtime and fixture freeze. An earlier 1355-pass run occurred
  before the three transport-disconnect cases and is not the final receipt.
- Full root build passed: both API compiler modes, library/app/scripts types,
  169 compiled cold-start/auth/denial checks and Vite. The existing nonfatal
  tooltip sourcemap warning remains. No frontend source/style changed.
- Fixed no-network isolation: 931/931. All test/build processes have terminal
  success receipts. Smaller/historical sets overlap and are not summed.

Only two reviewed normalized hashes change in the fixed 41-reader manifest:
generation 061690abaae7f64d4815ab993f02301cad716cd8e813309672e2aac7a1e5db81;
content-studio API a91e38915dc382661366a9983df5e706bb3f8fd2c61f9bd6830d91d8288b844e.
The environment reader/key set, fixed test list, network denial and IPC guards
are unchanged. The lifetime module reads no environment values. Protected raw
059/065 hashes match the previous receipts; neither file is edited or staged.
No database or browser was created. The existing owned temporary loopback HTTP
test closes its server; user demo servers and user browser sessions are unchanged.

## Not A Rollback Or Whole-Platform Completion

The budget stops application waits and future application operations. It cannot
undo a committed SQL/upload operation, promise interruption inside an already
entered SDK/Auth helper, preempt synchronous CPU work or prove a physical-host
wall-clock/resource limit. Read-only auth internals or an admitted SDK request
may still finish internally. Provider/HTTP cancellation is best effort; unsafe
late application continuations and response publication are fenced regardless.

A dispatch with no provider ID still needs reconciliation/manual review. A
late quota reserve may also retain conservative quota and a native reservation
instead of being falsely called rolled back. This cycle does not invent provider
lookup/idempotency or an automatic paid retry/refund. A changed prompt is a new
intent under the unchanged existing contract, not a globally deduplicated render.

The 50-second budget applies to these two generated-video routes, not all CRM,
image/text, worker or Telegram endpoints. It does not enlarge any native worker
permission. Actual private Storage/version/fence and legacy-object plan, native
Linux/host resource acceptance, real isolated Auth/session/provider/queue matrix
and the current G7 Preview isolation/release gate remain. G1-G8 and recruitment
commercial/legal gates are not redefined around this local increment.

## Later Local Quota Recovery

G5-C60 / G7-C37 [quota recovery](VIDEO-QUOTA-RECOVERY-2026-10-26.md) supersedes
only the unexpired, original pre-dispatch quota-ACK gap above. A same-key retry
must prove its original reserved receipt through coordinated forward 106; the
old unbound dispatch RPC is revoked. No new render is allowed for unknown
provider dispatch, expired/cancelled native rows, mismatched/ambiguous receipts
or failed/unknown quota. The 50-second wait budget and all other limits remain.
106 is prepared and verified locally only, not applied to any cloud database.
