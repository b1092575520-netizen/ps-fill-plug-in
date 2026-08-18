import type {
  LocalInpaintModel,
  SelectionBounds,
} from "../types";

export interface InpaintGeometry {
  cropBounds: SelectionBounds;
  targetWidth: number;
  targetHeight: number;
  featherRadius: number;
  edgeSampleRadius: number;
  /** Native crop pixels used to blend the returned image into Photoshop. */
  compositeFeatherRadius: number;
}

export interface SelectionMaskBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function assertInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
}

function assertPixelCoordinate(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负整数`);
  }
}

/**
 * Places the pixels returned by imaging.getSelection into a full crop-sized
 * grayscale raster. Photoshop may trim the returned sourceBounds to the
 * non-empty selection, so the returned raster is not necessarily crop-sized.
 */
export function rasterizeSelectionMask(
  cropBounds: SelectionBounds,
  sourceBounds: SelectionMaskBounds,
  sourceWidth: number,
  sourceHeight: number,
  components: number,
  sourceData: ArrayLike<number>,
) {
  assertPixelCoordinate(cropBounds.x, "裁切 X 坐标");
  assertPixelCoordinate(cropBounds.y, "裁切 Y 坐标");
  assertInteger(cropBounds.width, "裁切宽度");
  assertInteger(cropBounds.height, "裁切高度");
  assertInteger(sourceWidth, "选区返回宽度");
  assertInteger(sourceHeight, "选区返回高度");
  assertInteger(components, "选区返回通道数");
  for (const [value, label] of [
    [sourceBounds.left, "选区返回左坐标"],
    [sourceBounds.top, "选区返回上坐标"],
    [sourceBounds.right, "选区返回右坐标"],
    [sourceBounds.bottom, "选区返回下坐标"],
  ] as const) {
    assertPixelCoordinate(value, label);
  }
  const expectedRight = sourceBounds.left + sourceWidth;
  const expectedBottom = sourceBounds.top + sourceHeight;
  if (
    ![sourceBounds.left, sourceBounds.top, sourceBounds.right, sourceBounds.bottom]
      .every(Number.isFinite)
    || sourceBounds.right !== expectedRight
    || sourceBounds.bottom !== expectedBottom
  ) {
    throw new Error("Photoshop 返回的选区尺寸与 sourceBounds 不一致");
  }
  const offsetX = sourceBounds.left - cropBounds.x;
  const offsetY = sourceBounds.top - cropBounds.y;
  if (
    !Number.isInteger(offsetX)
    || !Number.isInteger(offsetY)
    || offsetX < 0
    || offsetY < 0
    || offsetX + sourceWidth > cropBounds.width
    || offsetY + sourceHeight > cropBounds.height
  ) {
    throw new Error("Photoshop 返回的选区超出局部重绘裁切区域");
  }
  const expectedLength = sourceWidth * sourceHeight * components;
  if (sourceData.length !== expectedLength) {
    throw new Error("Photoshop 返回的选区像素长度与尺寸不一致");
  }
  const output = new Uint8Array(cropBounds.width * cropBounds.height);
  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < sourceWidth; x += 1) {
      const value = Number(sourceData[(y * sourceWidth + x) * components]);
      if (!Number.isFinite(value) || value < 0 || value > 255) {
        throw new Error("Photoshop 返回了无法处理的选区灰度值");
      }
      output[(offsetY + y) * cropBounds.width + offsetX + x] = Math.round(value);
    }
  }
  return output;
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array) {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = new Uint8Array(4);
  for (let index = 0; index < type.length; index += 1) {
    typeBytes[index] = type.charCodeAt(index) & 0xff;
  }
  const payload = new Uint8Array(typeBytes.length + data.length);
  payload.set(typeBytes);
  payload.set(data, typeBytes.length);
  const chunk = new Uint8Array(12 + data.length);
  writeUint32(chunk, 0, data.length);
  chunk.set(payload, 4);
  writeUint32(chunk, 8 + data.length, crc32(payload));
  return chunk;
}

/**
 * Encodes an 8-bit grayscale raster as a standards-compliant, lossless PNG.
 * Stored DEFLATE blocks avoid relying on Node-only zlib APIs unavailable in UXP.
 */
export function encodeGrayscalePng(
  pixels: Uint8Array,
  width: number,
  height: number,
) {
  assertInteger(width, "PNG 宽度");
  assertInteger(height, "PNG 高度");
  if (pixels.length !== width * height) {
    throw new Error("PNG 灰度像素长度与尺寸不一致");
  }
  const scanlines = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    scanlines[y * (width + 1)] = 0;
    scanlines.set(
      pixels.subarray(y * width, (y + 1) * width),
      y * (width + 1) + 1,
    );
  }
  const blocks: Uint8Array[] = [];
  let cursor = 0;
  while (cursor < scanlines.length) {
    const size = Math.min(0xffff, scanlines.length - cursor);
    const block = new Uint8Array(5 + size);
    block[0] = cursor + size === scanlines.length ? 1 : 0;
    block[1] = size & 0xff;
    block[2] = (size >>> 8) & 0xff;
    block[3] = (~size) & 0xff;
    block[4] = ((~size) >>> 8) & 0xff;
    block.set(scanlines.subarray(cursor, cursor + size), 5);
    blocks.push(block);
    cursor += size;
  }
  const idatLength = 2 + blocks.reduce((total, block) => total + block.length, 0) + 4;
  const idat = new Uint8Array(idatLength);
  idat[0] = 0x78;
  idat[1] = 0x01;
  let idatOffset = 2;
  for (const block of blocks) {
    idat.set(block, idatOffset);
    idatOffset += block.length;
  }
  writeUint32(idat, idatOffset, adler32(scanlines));
  const header = new Uint8Array(13);
  writeUint32(header, 0, width);
  writeUint32(header, 4, height);
  header[8] = 8;
  header[9] = 0;
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const result = new Uint8Array(
    signature.length + 25 + idat.length + 24,
  );
  let resultOffset = 0;
  result.set(signature, resultOffset);
  resultOffset += signature.length;
  const ihdr = pngChunk("IHDR", header);
  result.set(ihdr, resultOffset);
  resultOffset += ihdr.length;
  const idatChunk = pngChunk("IDAT", idat);
  result.set(idatChunk, resultOffset);
  resultOffset += idatChunk.length;
  result.set(pngChunk("IEND", new Uint8Array()), resultOffset);
  return result;
}

const MODEL_MAX_EDGE: Record<LocalInpaintModel, number> = {
  "klein-9b": 768,
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function computeInpaintGeometry(
  selection: SelectionBounds,
  documentWidth: number,
  documentHeight: number,
  model: LocalInpaintModel,
): InpaintGeometry {
  if (
    documentWidth <= 0
    || documentHeight <= 0
    || selection.width <= 0
    || selection.height <= 0
  ) {
    throw new Error("选区或文档尺寸无效");
  }
  const maximumSelectionEdge = Math.max(selection.width, selection.height);
  // Keep enough surrounding context for seamless edges without shrinking a
  // small selected area into a low-resolution fraction of the model input.
  const expansion = maximumSelectionEdge * 0.5;
  const desiredWidth = Math.max(256, selection.width + expansion * 2);
  const desiredHeight = Math.max(256, selection.height + expansion * 2);
  const cropWidth = Math.min(documentWidth, desiredWidth);
  const cropHeight = Math.min(documentHeight, desiredHeight);
  const centerX = selection.x + selection.width / 2;
  const centerY = selection.y + selection.height / 2;
  const x = clamp(centerX - cropWidth / 2, 0, documentWidth - cropWidth);
  const y = clamp(centerY - cropHeight / 2, 0, documentHeight - cropHeight);
  const maxEdge = MODEL_MAX_EDGE[model];
  const scale = Math.min(1, maxEdge / Math.max(cropWidth, cropHeight));
  // These fields describe the native crop now. The provider performs the
  // only model-space resize, so writeback can map the returned image back to
  // this exact crop without a second Photoshop resample.
  const nativeWidth = Math.round(cropWidth);
  const nativeHeight = Math.round(cropHeight);
  const targetWidth = nativeWidth;
  const targetHeight = nativeHeight;
  const selectedTargetEdge = maximumSelectionEdge * scale;
  // The model-space feather is too small once the result is restored to a
  // high-resolution Photoshop crop. Convert it back to native pixels and cap
  // it so small selections stay crisp while large portraits blend naturally.
  const compositeFeatherRadius = clamp(
    Math.round(selectedTargetEdge * 0.035 / Math.max(scale, 0.01)),
    4,
    64,
  );
  return {
    cropBounds: {
      x: Math.round(x),
      y: Math.round(y),
      width: nativeWidth,
      height: nativeHeight,
    },
    targetWidth,
    targetHeight,
    featherRadius: clamp(Math.round(selectedTargetEdge * 0.025), 4, 16),
    edgeSampleRadius: clamp(Math.round(selectedTargetEdge * 0.03), 8, 16),
    compositeFeatherRadius,
  };
}

export interface CompositeInput {
  width: number;
  height: number;
  source: Uint8ClampedArray;
  generated: Uint8ClampedArray;
  mask: Uint8Array;
  featherRadius: number;
  edgeSampleRadius: number;
  colorMatch?: boolean;
}

function validatePixels(input: CompositeInput) {
  const pixels = input.width * input.height;
  if (
    input.width <= 0
    || input.height <= 0
    || input.source.length !== pixels * 4
    || input.generated.length !== pixels * 4
    || input.mask.length !== pixels
  ) {
    throw new Error("局部重绘像素数据尺寸不一致");
  }
}

function maskDistance(mask: Uint8Array, width: number, height: number) {
  const infinity = width + height + 1;
  const distance = new Uint16Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    distance[index] = mask[index] > 0 ? infinity : 0;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!distance[index]) continue;
      const left = x > 0 ? distance[index - 1] + 1 : infinity;
      const top = y > 0 ? distance[index - width] + 1 : infinity;
      distance[index] = Math.min(distance[index], left, top);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (!distance[index]) continue;
      const right = x + 1 < width ? distance[index + 1] + 1 : infinity;
      const bottom = y + 1 < height ? distance[index + width] + 1 : infinity;
      distance[index] = Math.min(distance[index], right, bottom);
    }
  }
  return distance;
}

/**
 * Builds a soft mask that fades only toward the inside of the original
 * selection. Pixels outside the user's selection remain exactly zero, so the
 * final composite cannot alter the surrounding document while still avoiding
 * a hard seam at the selection edge.
 */
export function featherSelectionMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
) {
  assertInteger(width, "遮罩宽度");
  assertInteger(height, "遮罩高度");
  if (mask.length !== width * height) {
    throw new Error("遮罩像素长度与尺寸不一致");
  }
  const feather = Math.max(0, Math.round(radius));
  if (feather === 0) return new Uint8Array(mask);
  const distance = maskDistance(mask, width, height);
  const output = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const alpha = Math.min(mask[index] / 255, distance[index] / feather);
    output[index] = Math.round(alpha * 255);
  }
  return output;
}

function edgeMeans(input: CompositeInput, distance: Uint16Array) {
  const source = [0, 0, 0];
  const generated = [0, 0, 0];
  let sourceCount = 0;
  let generatedCount = 0;
  for (let index = 0; index < input.mask.length; index += 1) {
    const pixel = index * 4;
    const inInnerRing = input.mask[index] > 0 && distance[index] <= input.edgeSampleRadius;
    if (inInnerRing) {
      for (let channel = 0; channel < 3; channel += 1) {
        source[channel] += input.source[pixel + channel];
        generated[channel] += input.generated[pixel + channel];
      }
      sourceCount += 1;
      generatedCount += 1;
    }
  }
  if (!sourceCount || !generatedCount) return { source: [0, 0, 0], generated: [0, 0, 0] };
  return {
    source: source.map((value) => value / sourceCount),
    generated: generated.map((value) => value / generatedCount),
  };
}

export function matchAndCompositeRgba(input: CompositeInput) {
  validatePixels(input);
  const distance = maskDistance(input.mask, input.width, input.height);
  const means = edgeMeans(input, distance);
  const shifts = means.source.map((value, channel) => (
    input.colorMatch === false ? 0 : value - means.generated[channel]
  ));
  const output = new Uint8ClampedArray(input.source);
  const feather = clamp(Math.round(input.featherRadius), 4, 16);
  for (let index = 0; index < input.mask.length; index += 1) {
    if (!input.mask[index]) continue;
    const alpha = Math.min(
      input.mask[index] / 255,
      distance[index] / feather,
    );
    const pixel = index * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const adjusted = clamp(input.generated[pixel + channel] + shifts[channel], 0, 255);
      output[pixel + channel] = Math.round(
        adjusted * alpha + input.source[pixel + channel] * (1 - alpha),
      );
    }
    output[pixel + 3] = 255;
  }
  return output;
}
