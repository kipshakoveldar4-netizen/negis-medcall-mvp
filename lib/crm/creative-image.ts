import { sniffImageMimeType } from "../content-studio/generation";

export const MAX_CREATIVE_IMAGE_PIXELS = 40_000_000;
const MAX_CREATIVE_IMAGE_BYTES = 10 * 1024 * 1024;
const INVALID_IMAGE = "Файл повреждён или не является поддерживаемым изображением JPG, PNG или WEBP.";

export class CreativeImageValidationUnavailable extends Error {
  constructor() {
    super("Проверка изображения временно недоступна. Файл не загружен.");
  }
}

export async function validateCreativeImageBytes(input: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}): Promise<string[]> {
  if (!input.buffer.length || input.buffer.length > MAX_CREATIVE_IMAGE_BYTES) {
    return ["Изображение должно быть непустым и не больше 10 МБ."];
  }
  const mimeType = input.mimeType.trim().toLowerCase();
  const actualMime = sniffImageMimeType(input.buffer);
  const extension = input.fileName.split(".").at(-1)?.toLowerCase() || "";
  const expectedExtensions: Record<string, string[]> = {
    "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"],
  };
  if (!actualMime || actualMime !== mimeType
    || !expectedExtensions[actualMime]?.includes(extension)) return [INVALID_IMAGE];

  const sharp = await import("sharp").then((module) => module.default, () => {
    throw new CreativeImageValidationUnavailable();
  });
  try {
    const image = sharp(input.buffer, {
      failOn: "warning", limitInputPixels: MAX_CREATIVE_IMAGE_PIXELS, animated: true,
    }).timeout({ seconds: 5 });
    const metadata = await image.metadata();
    const formats: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    if (formats[metadata.format || ""] !== actualMime || !metadata.width || !metadata.height
      || metadata.width * metadata.height > MAX_CREATIVE_IMAGE_PIXELS) return [INVALID_IMAGE];
    // Metadata alone does not prove compressed pixel data can be decoded.
    await image.stats();
    return [];
  } catch {
    return [INVALID_IMAGE];
  }
}
