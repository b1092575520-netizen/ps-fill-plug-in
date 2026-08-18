import { describe, expect, it } from "vitest";
import {
  computeInpaintGeometry,
  encodeGrayscalePng,
  featherSelectionMask,
  matchAndCompositeRgba,
  rasterizeSelectionMask,
} from "../src/backend/localInpaintGeometry";

describe("local inpaint geometry and compositing", () => {
  it("keeps a compact context crop so the selected area retains model detail", () => {
    expect(computeInpaintGeometry(
      { x: 800, y: 400, width: 200, height: 100 },
      2000,
      1000,
      "klein-9b",
    )).toEqual({
      cropBounds: { x: 700, y: 300, width: 400, height: 300 },
      targetWidth: 400,
      targetHeight: 300,
      featherRadius: 5,
      edgeSampleRadius: 8,
      compositeFeatherRadius: 7,
    });
  });

  it("feathers only inside the original selection and preserves outside zeros", () => {
    const mask = new Uint8Array([
      0, 0, 0, 0, 0,
      0, 255, 255, 255, 0,
      0, 255, 255, 255, 0,
      0, 255, 255, 255, 0,
      0, 0, 0, 0, 0,
    ]);
    const softened = featherSelectionMask(mask, 5, 5, 2);
    expect(Array.from(softened.slice(0, 5))).toEqual([0, 0, 0, 0, 0]);
    expect(softened[6]).toBe(128);
    expect(softened[12]).toBe(255);
    expect(softened[8]).toBe(128);
    expect(softened[18]).toBe(128);
    expect(softened[24]).toBe(0);
  });

  it("places a trimmed multi-channel selection at its document-to-crop offset", () => {
    const mask = rasterizeSelectionMask(
      { x: 220, y: 1386, width: 6, height: 5 },
      { left: 222, top: 1388, right: 225, bottom: 1390 },
      3,
      2,
      3,
      new Uint8Array([
        20, 20, 20, 40, 40, 40, 60, 60, 60,
        80, 80, 80, 100, 100, 100, 120, 120, 120,
      ]),
    );

    expect(Array.from(mask)).toEqual([
      0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0,
      0, 0, 20, 40, 60, 0,
      0, 0, 80, 100, 120, 0,
      0, 0, 0, 0, 0, 0,
    ]);
  });

  it("rejects trimmed selection pixels whose bounds or length are inconsistent", () => {
    expect(() => rasterizeSelectionMask(
      { x: 10, y: 20, width: 4, height: 4 },
      { left: 9, top: 20, right: 11, bottom: 22 },
      2,
      2,
      1,
      new Uint8Array(4),
    )).toThrow("超出局部重绘裁切区域");
    expect(() => rasterizeSelectionMask(
      { x: 10, y: 20, width: 4, height: 4 },
      { left: 11, top: 21, right: 13, bottom: 23 },
      2,
      2,
      1,
      new Uint8Array(3),
    )).toThrow("像素长度与尺寸不一致");
    expect(() => rasterizeSelectionMask(
      { x: 10.5, y: 20, width: 4, height: 4 },
      { left: 11, top: 21, right: 13, bottom: 23 },
      2,
      2,
      1,
      new Uint8Array(4),
    )).toThrow("裁切 X 坐标");
  });

  it("encodes the full crop mask as a lossless 8-bit grayscale PNG", () => {
    const pixels = new Uint8Array([0, 32, 64, 96, 128, 255]);
    const png = encodeGrayscalePng(pixels, 3, 2);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const readUint32 = (offset: number) => (
      (png[offset] * 0x1000000)
      + (png[offset + 1] << 16)
      + (png[offset + 2] << 8)
      + png[offset + 3]
    ) >>> 0;
    expect(readUint32(16)).toBe(3);
    expect(readUint32(20)).toBe(2);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(0);

    let offset = 8;
    let idat = new Uint8Array();
    while (offset < png.length) {
      const length = readUint32(offset);
      const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
      if (type === "IDAT") idat = png.slice(offset + 8, offset + 8 + length);
      offset += 12 + length;
    }
    const inflated: number[] = [];
    let compressedOffset = 2;
    while (compressedOffset < idat.length - 4) {
      const final = idat[compressedOffset] & 1;
      const length = idat[compressedOffset + 1] | (idat[compressedOffset + 2] << 8);
      const inverse = idat[compressedOffset + 3] | (idat[compressedOffset + 4] << 8);
      expect((length ^ inverse) & 0xffff).toBe(0xffff);
      inflated.push(...idat.subarray(compressedOffset + 5, compressedOffset + 5 + length));
      compressedOffset += 5 + length;
      if (final) break;
    }
    expect(inflated).toEqual([0, 0, 32, 64, 0, 96, 128, 255]);
  });

  it("keeps every pixel outside the arbitrary mask byte-for-byte unchanged", () => {
    const width = 7;
    const height = 7;
    const source = new Uint8ClampedArray(width * height * 4).fill(100);
    const generated = new Uint8ClampedArray(width * height * 4).fill(200);
    const mask = new Uint8Array(width * height);
    for (let y = 2; y <= 4; y += 1) {
      for (let x = 2; x <= 4; x += 1) mask[y * width + x] = 255;
    }
    const output = matchAndCompositeRgba({
      width,
      height,
      source,
      generated,
      mask,
      featherRadius: 4,
      edgeSampleRadius: 8,
    });
    for (let index = 0; index < mask.length; index += 1) {
      if (mask[index]) continue;
      expect(Array.from(output.slice(index * 4, index * 4 + 4)))
        .toEqual(Array.from(source.slice(index * 4, index * 4 + 4)));
    }
  });

  it("matches boundary color before feathering to remove a synthetic seam", () => {
    const width = 7;
    const height = 7;
    const source = new Uint8ClampedArray(width * height * 4).fill(100);
    const generated = new Uint8ClampedArray(width * height * 4).fill(200);
    const mask = new Uint8Array(width * height);
    for (let y = 1; y <= 5; y += 1) {
      for (let x = 1; x <= 5; x += 1) mask[y * width + x] = 255;
    }
    const center = (3 * width + 3) * 4;
    const matched = matchAndCompositeRgba({
      width,
      height,
      source,
      generated,
      mask,
      featherRadius: 4,
      edgeSampleRadius: 8,
    });
    const unmatched = matchAndCompositeRgba({
      width,
      height,
      source,
      generated,
      mask,
      featherRadius: 4,
      edgeSampleRadius: 8,
      colorMatch: false,
    });
    expect(Math.abs(matched[center] - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(unmatched[center] - 100)).toBeGreaterThan(40);
  });
});
