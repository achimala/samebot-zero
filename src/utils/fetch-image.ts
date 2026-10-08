import type { Logger } from "pino";

const FETCH_TIMEOUT_MS = 10_000;

/** Downloads an image URL into base64 for APIs that need inline image data. */
export async function fetchImageAsBase64(
  url: string,
  logger: Logger,
): Promise<{ data: string; mimeType: string } | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn({ url, status: response.status }, "Failed to fetch image");
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType =
      response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    return { data: buffer.toString("base64"), mimeType };
  } catch (error) {
    logger.warn({ err: error, url }, "Failed to fetch image");
    return null;
  }
}
