import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import { fitProviderImage, PROVIDER_IMAGE_MAX_BYTES } from "./providerImageFit.ts";

/**
 * An uncompressed PNG stands in for a phone screenshot of a photo: huge on
 * disk. `noise` is the per-pixel jitter; 255 is pure noise.
 */
async function noisyPng(width: number, height: number, noise = 255): Promise<Uint8Array> {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let index = 0; index < pixels.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const pixel = Math.floor(index / 3);
    const base = ((pixel % width) + Math.floor(pixel / width)) % 256;
    pixels[index] = noise === 255 ? seed & 0xff : (base + (seed % (noise + 1))) & 0xff;
  }
  return new Uint8Array(
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer(),
  );
}

describe("fitProviderImage", () => {
  it("leaves images that already fit untouched", async () => {
    const bytes = await noisyPng(64, 64);
    const result = await fitProviderImage({ bytes, mimeType: "image/png" });
    expect(result.changed).toBe(false);
    expect(result.bytes).toBe(bytes);
    expect(result.mimeType).toBe("image/png");
  });

  it("re-encodes an oversized screenshot at its original resolution first", async () => {
    // 1170x2532 is an iPhone screenshot; uncompressed it is ~8.9 MB.
    const bytes = await noisyPng(1170, 2532, 24);
    expect(bytes.byteLength).toBeGreaterThan(PROVIDER_IMAGE_MAX_BYTES);
    const result = await fitProviderImage({ bytes, mimeType: "image/png" });
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.bytes.byteLength).toBeLessThanOrEqual(PROVIDER_IMAGE_MAX_BYTES);
    // 4/3 of the raw size is the base64 the provider checks against 5 MiB.
    expect(Math.ceil(result.bytes.byteLength / 3) * 4).toBeLessThanOrEqual(5 * 1024 * 1024);
    const metadata = await sharp(Buffer.from(result.bytes)).metadata();
    expect({ width: metadata.width, height: metadata.height }).toEqual({
      width: 1170,
      height: 2532,
    });
  });

  it("scales down only when quality alone cannot fit the limit", async () => {
    const bytes = await noisyPng(1600, 1600);
    const result = await fitProviderImage({ bytes, mimeType: "image/png" }, { maxBytes: 400_000 });
    expect(result.changed).toBe(true);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(400_000);
    const metadata = await sharp(Buffer.from(result.bytes)).metadata();
    expect(metadata.width).toBeLessThan(1600);
    expect(metadata.width).toBeGreaterThanOrEqual(1024);
  });

  it("sends the original when the encoder is unavailable", async () => {
    const bytes = await noisyPng(1170, 2532);
    const result = await fitProviderImage(
      { bytes, mimeType: "image/png" },
      { loadEncoder: async () => null },
    );
    expect(result).toMatchObject({ changed: false, mimeType: "image/png" });
    expect(result.bytes).toBe(bytes);
  });
});
