/**
 * Fork: providers reject images over 5 MiB of base64 (ACP shows "Internal error").
 * Fitting images go out untouched; larger ones become JPEG at full resolution,
 * and only shrink if that still does not fit.
 */
import * as Effect from "effect/Effect";

/** 5 MiB of base64 is 3.75 MiB of raw bytes; keep a margin below it. */
export const PROVIDER_IMAGE_MAX_BYTES = Math.floor(((5 * 1024 * 1024) / 4) * 3 * 0.97);
/** Anthropic rejects images with an edge longer than 8000 px. */
export const PROVIDER_IMAGE_MAX_EDGE = 8000;
const JPEG_QUALITIES = [90, 82, 74] as const;
const DOWNSCALE_STEP = 0.85;
const MIN_DOWNSCALE_EDGE = 1024;

export interface ProviderImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface ProviderImageFitResult extends ProviderImage {
  readonly changed: boolean;
  readonly originalBytes: number;
}

type SharpModule = typeof import("sharp");
type SharpFactory = SharpModule["default"];

let sharpLoad: Promise<SharpFactory | null> | undefined;

/** sharp is optional at runtime; without it images are sent as before. */
function loadSharp(): Promise<SharpFactory | null> {
  sharpLoad ??= import("sharp").then(
    (module) => (module as unknown as { default?: SharpFactory }).default ?? (module as never),
    () => null,
  );
  return sharpLoad;
}

function needsFit(image: ProviderImage, maxBytes: number): boolean {
  return image.bytes.byteLength > maxBytes;
}

export async function fitProviderImage(
  image: ProviderImage,
  options: {
    readonly maxBytes?: number;
    readonly maxEdge?: number;
    readonly loadEncoder?: () => Promise<SharpFactory | null>;
  } = {},
): Promise<ProviderImageFitResult> {
  const maxBytes = options.maxBytes ?? PROVIDER_IMAGE_MAX_BYTES;
  const maxEdge = options.maxEdge ?? PROVIDER_IMAGE_MAX_EDGE;
  const unchanged: ProviderImageFitResult = {
    ...image,
    changed: false,
    originalBytes: image.bytes.byteLength,
  };
  if (!needsFit(image, maxBytes)) return unchanged;
  const sharp = await (options.loadEncoder ?? loadSharp)();
  if (sharp === null) return unchanged;
  const input = Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
  const metadata = await sharp(input, { animated: false }).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) return unchanged;
  let edge = Math.min(Math.max(width, height), maxEdge);
  const encode = (longEdge: number, quality: number) =>
    sharp(input, { animated: false })
      .rotate()
      .resize({
        width: width >= height ? longEdge : undefined,
        height: height > width ? longEdge : undefined,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  let smallest: Buffer | undefined;
  for (;;) {
    for (const quality of JPEG_QUALITIES) {
      const output = await encode(edge, quality);
      if (smallest === undefined || output.byteLength < smallest.byteLength) smallest = output;
      if (output.byteLength <= maxBytes) {
        return {
          bytes: new Uint8Array(output.buffer, output.byteOffset, output.byteLength),
          mimeType: "image/jpeg",
          changed: true,
          originalBytes: image.bytes.byteLength,
        };
      }
    }
    const next = Math.floor(edge * DOWNSCALE_STEP);
    if (next < MIN_DOWNSCALE_EDGE) break;
    edge = next;
  }
  // Still too large; send the smallest attempt and let the provider decide.
  return smallest === undefined
    ? unchanged
    : {
        bytes: new Uint8Array(smallest.buffer, smallest.byteOffset, smallest.byteLength),
        mimeType: "image/jpeg",
        changed: true,
        originalBytes: image.bytes.byteLength,
      };
}

/** Effect wrapper: a failed re-encode falls back to the original bytes. */
export const fitProviderImageEffect = (
  image: ProviderImage,
  options?: Parameters<typeof fitProviderImage>[1],
): Effect.Effect<ProviderImageFitResult> =>
  Effect.tryPromise(() => fitProviderImage(image, options)).pipe(
    Effect.tap((result) =>
      result.changed
        ? Effect.logInfo("provider image re-encoded to fit provider limit", {
            originalBytes: result.originalBytes,
            bytes: result.bytes.byteLength,
            mimeType: result.mimeType,
          })
        : Effect.void,
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("provider image fit failed; sending original", { cause }).pipe(
        Effect.as({ ...image, changed: false, originalBytes: image.bytes.byteLength }),
      ),
    ),
  );
