import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  demoAvatarPrompt,
  generateOpenAIJson,
  normalizePromptPackage,
  updateContentVideo,
} from "../../lib/content-studio/core";
import { persistContentVideoPatchIfAvailable } from "../../lib/crm/server";

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
    const fallback = demoAvatarPrompt(payload);
    const result = await generateOpenAIJson({
      system:
        "Generate production-ready prompts for realistic AI avatar photo/video tools. Return valid JSON only.",
      user: {
        task: "Generate avatar prompt for healthcare and marketing short-form video.",
        requiredJsonFields: ["prompt", "negativePrompt", "format"],
        input: payload,
      },
      fallback,
      normalize: (value) => normalizePromptPackage(value, fallback),
    });

    if (typeof payload.videoId === "string") {
      const patch = {
        avatarPrompt: [result.data.prompt, result.data.negativePrompt ? `Negative prompt: ${result.data.negativePrompt}` : null]
          .filter(Boolean)
          .join("\n\n"),
        status: "avatar_ready" as const,
      };
      updateContentVideo(payload.videoId, patch);
      await persistContentVideoPatchIfAvailable({
        videoId: payload.videoId,
        workspaceId: payload.workspaceId,
        patch,
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
      details: [error instanceof Error ? error.message : "Failed to generate avatar prompt"],
    });
  }
}
