import { sniffImageMimeType } from "../content-studio/generation";

export const MAX_CREATIVE_IMAGE_PIXELS = 40_000_000;
const MAX_CREATIVE_IMAGE_BYTES = 10 * 1024 * 1024;
const INVALID_IMAGE = "Файл повреждён или не является поддерживаемым изображением JPG, PNG или WEBP.";

export class CreativeImageValidationUnavailable extends Error {
  constructor() {
    super("Проверка изображения временно недоступна. Файл не загружен.");
  }
}

/** Re-encode accepted pixels, not the original container or its private metadata. */
export async function normalizeCreativeImageBytes(input: { buffer: Buffer; fileName: string; mimeType: string }): Promise<Buffer> {
  const details = await validateCreativeImageBytes(input);
  if (details.length) throw new Error(details.join(" "));
  const mimeType = input.mimeType.trim().toLowerCase();
  const sharp = await import("sharp").then(module => module.default, () => { throw new CreativeImageValidationUnavailable(); });
  try {
    let image = sharp(input.buffer, { failOn: "warning", limitInputPixels: MAX_CREATIVE_IMAGE_PIXELS, animated: true })
      .autoOrient().toColourspace("srgb").timeout({ seconds: 5 });
    if (mimeType === "image/jpeg") image = image.jpeg({ quality: 92 });
    else if (mimeType === "image/png") image = image.png();
    else image = image.webp({ quality: 92 });
    const output = await image.toBuffer();
    if (!output.length || output.length > MAX_CREATIVE_IMAGE_BYTES || sniffImageMimeType(output) !== mimeType) throw new Error();
    return output;
  } catch { throw new Error(INVALID_IMAGE); }
}

function pngNeedsAnimationDecoder(buffer: Buffer): boolean {
  // Sharp's PNG loader may decode only the APNG poster, even with animated:true.
  // Inspect chunk framing, not compressed pixels; native decoding remains mandatory.
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length - offset - 12) return true;
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return true;
    if (type === "IEND") return false;
    offset += length + 12;
  }
  return true;
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
  if (actualMime === "image/png" && pngNeedsAnimationDecoder(input.buffer)) {
    return ["Анимированный или повреждённый PNG не поддерживается. Сохраните обычный PNG или используйте видео."];
  }

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
    // stats() does not consume Sharp's native timeout; a full raw pipeline does.
    await image.toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" }).toBuffer();
    return [];
  } catch {
    return [INVALID_IMAGE];
  }
}
