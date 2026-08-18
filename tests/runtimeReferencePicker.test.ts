import { describe, expect, it } from "vitest";
import { UXP_REFERENCE_PICKER_OPTIONS } from "../src/backend/runtime";

describe("UXP reference picker", () => {
  it("omits types so Windows shows one all-files choice instead of one dropdown item per format", () => {
    expect(UXP_REFERENCE_PICKER_OPTIONS).toEqual({ allowMultiple: true });
    expect(UXP_REFERENCE_PICKER_OPTIONS).not.toHaveProperty("types");
  });
});
