import { describe, expect, it } from "vitest";
import { InpaintIntentPlanner } from "../src/inpaintIntentPlanner";

const planner = new InpaintIntentPlanner();
const selectionBounds = { x: 10, y: 20, width: 200, height: 100 };

describe("InpaintIntentPlanner", () => {
  it("turns an empty prompt into a structured removal and repair intent", () => {
    const result = planner.plan({ selectionBounds, contextImage: { width: 1000, height: 800 }, userPrompt: "", strength: "balanced" });
    expect(result.operation).toBe("remove-and-repair");
    expect(result.target).toMatch(/异常主体/);
    expect(result.compiledPrompt).not.toBe("");
    expect(result.compiledPrompt).not.toBe("移除");
    expect(result.preserve).toContain("选区外内容");
  });

  it.each([
    ["移除双下巴", "双下巴"],
    ["去掉头顶多余头发", "多余头发"],
    ["修掉衣物露出的一小截", "衣物露出"],
    ["去除皮肤瑕疵", "皮肤瑕疵"],
    ["清理背景杂物", "背景杂物"],
  ])("keeps the explicit instruction primary for %s", (userPrompt, target) => {
    const result = planner.plan({ selectionBounds, contextImage: { width: 1000, height: 800 }, userPrompt, strength: "strong" });
    expect(result.target).toBe(target);
    expect(result.compiledPrompt.indexOf(userPrompt)).toBeLessThan(result.compiledPrompt.indexOf("Preserve"));
  });
});
