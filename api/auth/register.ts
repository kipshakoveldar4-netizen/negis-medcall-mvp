import type { VercelRequest, VercelResponse } from "@vercel/node";
import { persistWorkspaceIfAvailable } from "../../lib/targeting-agent/persistence";

type RegisterBody = {
  name?: string;
  ownerName?: string;
  fullName?: string;
  workspaceName?: string;
  companyName?: string;
  clinicName?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

function errorBody(error: string, details: string[] = []) {
  return {
    success: false,
    error,
    details,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, errorBody("Method not allowed", ["Use POST"]));
  }

  const body = (req.body || {}) as RegisterBody;
  const name =
    readString(body.name) ||
    readString(body.ownerName) ||
    readString(body.fullName);
  const workspaceName =
    readString(body.workspaceName) ||
    readString(body.companyName) ||
    readString(body.clinicName);
  const email = readString(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const confirmPassword =
    typeof body.confirmPassword === "string" ? body.confirmPassword : password;
  const details: string[] = [];

  if (!name) details.push("name is required");
  if (!workspaceName) details.push("workspaceName is required");
  if (!email) details.push("email is required");
  if (!password) details.push("password is required");
  if (!email.includes("@") && email) details.push("email must be valid");
  if (password && password.length < 8) details.push("password must be at least 8 characters");
  if (password && confirmPassword && password !== confirmPassword) {
    details.push("passwords do not match");
  }

  if (details.length > 0) {
    return sendJson(res, 400, errorBody("Validation error", details));
  }

  const persistence = await persistWorkspaceIfAvailable({
    workspaceName,
    ownerEmail: email,
  });

  return sendJson(res, 200, {
    success: true,
    mode: "demo",
    ...(persistence.warning ? { warning: persistence.warning } : {}),
    data: {
      workspaceId: persistence.workspaceId,
      workspaceName,
      persistenceMode: persistence.persistenceMode,
      user: {
        id: "demo-user",
        name,
        email,
      },
      redirectTo: "/dashboard",
    },
  });
}
