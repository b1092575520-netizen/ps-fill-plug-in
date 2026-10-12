import type { ImageResolution } from "../types";

interface ModelPrice {
  pointsPerImage: number;
  /** Resolutions the published price covers; missing means all of them. */
  resolutions?: ImageResolution[];
}

// Xinbao points table supplied by the store on 2026-10-12 (1 元 = 60 积分).
// Xinbao adjusts prices with the market, so the panel shows an estimate only.
const XINBAO_IMAGE_PRICES: Record<string, ModelPrice> = {
  // 全能图像G-2.0 OAI：官方满血版，1-4K 同价
  "gpt-image-2-oai": { pointsPerImage: 12 },
  // 全能图像G-2.0：1-2K 同价，4K 未标价
  "gpt-image-2": { pointsPerImage: 6, resolutions: ["api-default", "1K", "2K"] },
};

/** Estimated points for one generation, or null when no price is published. */
export function estimateGenerationPoints(model: string, resolution: ImageResolution, count: number) {
  const price = XINBAO_IMAGE_PRICES[model];
  if (!price || (price.resolutions && !price.resolutions.includes(resolution))) return null;
  return Math.round(price.pointsPerImage * Math.max(1, count) * 10) / 10;
}
