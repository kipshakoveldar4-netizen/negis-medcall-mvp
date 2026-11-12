# Photo Upload Stream: Local Safety Evidence

28 October 2026. Test-only follow-up; no production handler/schema change.
No external request, real Auth identity, Storage bucket, advertising account,
customer file, payment, generation or cloud setting was used.

`test:crm-body-budget` now includes the independent native loopback photo stream
fixture. **39/39 passed**, including the existing body-budget suite and 17 tests
(including parent) for actual IncomingMessage -> compiled CRM catch-all ->
Busboy/Dicer/Sharp. Auth authority, SDK persistence, Storage and public-download
responses are explicit doubles, not deployed gateway or cloud ACL evidence.

Verified:

- Valid JPEG split across headers, magic bytes and multipart boundaries waits
  for real HTTP EOF before reservation, persistence or upload.
- Exact 10 MiB native-decodable JPEG succeeds; one extra image byte fails before
  those effects. Output rotates orientation and strips synthetic private EXIF.
  Persisted hash/path/size match the actual transformed JPEG.
- EOF within a JPEG, missing/mismatched closing boundary, incomplete metadata,
  duplicate request key, second file, malformed trailing part, truncated JPEG
  and falsely declared non-image all fail with no upload effects.
- Client disconnect within the image or after the envelope but before EOF has
  no upload effects. Unknown/auth-denied routes retain pre-body refusal.
- Oversized declared or actual multipart input gets a usable 413 without a
  cooperating sender's EOF, before reservation or Storage writes.

No vulnerability was reproduced in this selected matrix. The tests do not prove
every malformed image/parser/resource-exhaustion case, actual Vercel proxy limits,
real SDK/Storage rollback, cloud permissions, MP4 handling or provider delivery.
Those remain their own readiness gates. The protocol does not gain paid or
external access merely because this local fixture passes.
