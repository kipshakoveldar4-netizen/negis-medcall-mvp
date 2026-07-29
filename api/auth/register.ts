import type { VercelRequest, VercelResponse } from "@vercel/node";

// Security-2D — self-registration is disabled.
//
// This route accepted an unauthenticated POST and inserted a row into
// `workspaces` on the service-role client: anyone could create clinics in the
// production database, as fast as they could send requests. It also took a
// `password` field, validated its length, and then threw it away — no Supabase
// Auth user was ever created, so the account it appeared to open could not be
// logged into. The only durable effect was an orphan workspace row.
//
// Access is provisioned by the clinic owner today, and the staff route says the
// same thing (`409 staff_invitation_required`) until a verified invitation flow
// exists. Nothing here constructs a Supabase client or reads the body, so a
// request costs a database round trip of exactly zero.
//
// Do not re-enable this by adding an insert back. A real signup needs a
// verified email, a Supabase Auth user, an owner membership written in the same
// transaction, and abuse protection — that is a phase, not a patch.

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.status(410).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json({
    success: false,
    error: "Self-registration is disabled",
    code: "self_registration_disabled",
    details: ["Access is provisioned by the clinic owner."],
  });
}
