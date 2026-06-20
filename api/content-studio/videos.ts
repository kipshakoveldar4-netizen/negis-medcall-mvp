import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createContentVideo, listContentVideos } from "../../lib/content-studio/core";

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    return sendJson(res, 200, {
      success: true,
      mode: "mock",
      data: {
        videos: listContentVideos(),
      },
    });
  }

  if (req.method === "POST") {
    const video = createContentVideo((req.body || {}) as Record<string, unknown>);
    return sendJson(res, 201, {
      success: true,
      mode: "mock",
      data: {
        video,
      },
    });
  }

  return sendJson(res, 405, {
    success: false,
    error: "Method not allowed",
    details: ["Use GET or POST"],
  });
}
