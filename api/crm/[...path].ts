import type { VercelRequest, VercelResponse } from "@vercel/node";
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { createOperatorPreviewHandler } = await import("../../operator-preview/profile.mjs");
  const gate = createOperatorPreviewHandler(async () => {
    const crm = require("../../operator-preview/crm/handler") as typeof import("../../operator-preview/crm/handler");
    return crm.default;
  });
  return gate(req, res);
}
