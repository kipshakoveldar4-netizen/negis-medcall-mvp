import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  demoScriptPackage,
  generateOpenAIJson,
  normalizeScriptPackage,
  updateContentVideo,
} from "../../lib/content-studio/core";

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, {
      success: false,
      error: "Method not allowed",
      details: ["Use POST"],
    });
  }

  try {
    const payload = (req.body || {}) as Record<string, unknown>;
    const result = await generateOpenAIJson({
      system: "You are a Russian AI video script strategist. Return valid JSON only. No markdown.",
      user: {
        task: "Generate a short-form AI video package for 30-45 seconds.",
        requiredJsonFields: ["hook", "script", "voiceover", "cta", "caption", "hashtags"],
        requirements: {
          language: "Russian",
          outputStyle: "ready for avatar video production",
          hashtags: "5-8 hashtags as array",
        },
        input: payload,
      },
      fallback: demoScriptPackage(),
      normalize: normalizeScriptPackage,
    });

    if (typeof payload.videoId === "string") {
      updateContentVideo(payload.videoId, {
        ...result.data,
        status: "script_ready",
      });
    }

    return sendJson(res, 200, {
      success: true,
      mode: result.mode,
      data: result.data,
    });
  } catch (error) {
    return sendJson(res, 500, {
      success: false,
      error: "Generation error",
      details: [error instanceof Error ? error.message : "Failed to generate script package"],
    });
  }
}
