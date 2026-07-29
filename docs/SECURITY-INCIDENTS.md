# Security incidents

One entry per incident. Facts only: what happened, what it touched, what was
done, and what stops it recurring. No secrets, no production row contents, no
patient or clinic data — an identifier is recorded only when it is needed to
carry out or verify a cleanup.

---

## 2026-07-29 — Production CRM row created during Security-2 verification

**Detected:** 2026-07-29, during Security-2 production verification, immediately
after the request that caused it. The owner reopened the production gate the
same day.

**What happened.** The verification pass needed to demonstrate that a
`workspaceId` in a request body is ignored and that the query selector is the
only workspace authority. It demonstrated this by sending
`POST /api/crm/leads?workspaceId=<own>` with a foreign workspace in the body.
The server behaved correctly: the body was ignored and the row was created in
the caller's own workspace. The row was never removed, because `DELETE` on
`/api/crm/leads` is intentionally `405`.

**Violation.** Production verification is not permitted to create, update or
delete CRM records. A denial can be asserted from the response; it does not
require a write. The rule existed in the phase instructions and nowhere in the
tooling, so nothing refused the request.

**Scope.**

| | |
|---|---|
| Domain | `leads` |
| Row id | `cc290928-8ad3-4581-bc6b-7ffbe4ddcef0` |
| Row name | `__probe_never_committed__` |
| Workspace | `9eb6f100-bb6a-4f99-9719-e85c34513a03` (the verifying owner's own) |
| Source | Security-2 production verification |
| Other rows affected | none |
| Data exposed | none — no business row contents were read or transmitted |

**Cleanup.** Exactly one row, matched on all three of id, name and workspace,
deleted as a single operation after a preflight that confirmed one match and no
dependent rows. Recorded in the Security-2D final report.

**Prevention.**

- `scripts/src/production-verification-guard.ts` refuses any request that would
  change production state unless the owner has approved a specific operation id,
  and the allowlist is empty. It also refuses probe-named records at every
  target, refuses Meta endpoints outright, redacts credentials from logs, and
  reduces business responses to status, code and row count.
- `test:api-surface-authorization` (S21–S26) fails if those refusals are
  weakened, if the allowlist gains an entry without an approval, or if a
  verification script sends a mutation without going through the guard.
- `docs/PRODUCTION-VERIFICATION-CHECKLIST.md` states the read-only default in
  the procedure a person follows.

**Lesson.** "Verification is read-only" is a property of the tools or it is not
a property at all. A rule that lives only in a phase brief is one distracted
moment away from being broken by the person who wrote it down.
