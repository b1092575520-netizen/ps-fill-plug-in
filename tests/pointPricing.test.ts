import { describe, expect, it } from "vitest";
import { estimateGenerationPoints } from "../src/backend/pointPricing";

describe("estimateGenerationPoints", () => {
  it("uses the Xinbao points table per image", () => {
    expect(estimateGenerationPoints("gpt-image-2-oai", "4K", 4)).toBe(48);
    expect(estimateGenerationPoints("gpt-image-2-oai", "1K", 1)).toBe(12);
    expect(estimateGenerationPoints("gpt-image-2", "2K", 3)).toBe(18);
  });

  it("shows no figure where Xinbao has not published a price", () => {
    expect(estimateGenerationPoints("gpt-image-2", "4K", 1)).toBeNull();
    expect(estimateGenerationPoints("unknown-model", "2K", 1)).toBeNull();
    expect(estimateGenerationPoints("", "2K", 1)).toBeNull();
  });
});
