import type { InpaintStrength, SelectionBounds } from "./types";

export interface InpaintIntentInput {
  selectionBounds: SelectionBounds;
  contextImage: { width: number; height: number; mimeType?: string };
  userPrompt: string;
  strength: InpaintStrength;
}

export interface InpaintIntentPlan {
  operation: "remove-and-repair" | "repair" | "edit";
  target: string;
  strength: InpaintStrength;
  preserve: string[];
  compiledPrompt: string;
}

const TARGETS: Array<[RegExp, string]> = [
  [/双下巴/u, "双下巴"],
  [/(?:头顶|头上).*(?:一团|一撮|一束|多出来|多余)|(?:一团|一撮|一束)(?:多余的?)?头发/u, "多余头发"],
  [/(?:多余|额外).{0,4}头发|头发.{0,4}(?:多余|额外)/u, "多余头发"],
  [/头发|发髻|发团|hair|bun/iu, "头发"],
  [/衣(?:物|服).{0,6}(?:露出|外露)|(?:露出|外露).{0,6}衣(?:物|服)/u, "衣物露出"],
  [/皮肤.{0,4}(?:瑕疵|痘|斑)|(?:瑕疵|痘|斑).{0,4}皮肤/u, "皮肤瑕疵"],
  [/背景.{0,4}(?:杂物|杂乱|物体)|(?:杂物|杂乱).{0,4}背景/u, "背景杂物"],
];

const REMOVE = /OBJECT\s+REMOVAL|移除|去除|删除|消除|擦除|去掉|清除|清理|修掉|remove|erase|delete/iu;
const REPAIR = /修复|补全|修补|瑕疵|痘|斑|repair|heal/iu;

const STRENGTH_POLICY: Record<InpaintStrength, string> = {
  subtle: "Make a subtle, conservative edit while still completing the requested change.",
  balanced: "Make the requested change clearly and noticeably, while preserving unrelated details.",
  strong: "Make the requested change decisive and unmistakable. Do not return an unchanged or barely changed result.",
};

function englishTarget(requested: string, target: string) {
  if (target === "双下巴") return "the double chin";
  if (target === "多余头发") return /头顶|头上|clump|tuft/iu.test(requested)
    ? "the extra clump of hair on top of the head"
    : "the extra hair";
  if (target === "头发") return /selected upper hair bun/iu.test(requested)
    ? "the selected upper hair bun"
    : /发髻|发团|bun/iu.test(requested) ? "the hair bun" : "the hair";
  if (target === "衣物露出") return "the exposed extra piece of clothing";
  if (target === "皮肤瑕疵") return "the selected skin blemish";
  if (target === "背景杂物") return "the unwanted background clutter";
  const englishRemoval = requested.match(/\b(?:remove|erase|delete)\b\s+(?:the\s+)?(.+?)(?=[.!?]|\s+and\s+every|$)/iu)?.[1]?.trim();
  if (englishRemoval) return /^(?:the|a|an)\s/iu.test(englishRemoval) ? englishRemoval : `the ${englishRemoval}`;
  return "the unwanted object or feature inside the selected area";
}

export class InpaintIntentPlanner {
  plan(input: InpaintIntentInput): InpaintIntentPlan {
    const requested = input.userPrompt.trim();
    const preserve = ["选区外内容", "人物身份", "光照", "纹理", "透视"];
    if (!requested) {
      const target = "选区内异常主体或不连续内容";
      const policy = STRENGTH_POLICY[input.strength];
      return {
        operation: "remove-and-repair",
        target,
        strength: input.strength,
        preserve,
        compiledPrompt: `Treat the selected area as unwanted content to remove, not as a subject to recreate. If the selected content is hair or a bun, remove the hair or bun completely; otherwise remove the selected object or feature completely. Naturally reconstruct the missing anatomy or background from the surrounding context. Extend the surrounding background into the selected area with matching color, texture, lighting and perspective. Do not create a replacement object. Never generate a replacement object, hair, a hair bun, a coil, a facial feature, clothing, or any recognizable foreground detail inside the selected area. ${policy} Preserve identity, realistic anatomy, skin texture, lighting and perspective outside the selected area. Never copy the selected content back into the result. No unwanted object or trace may remain.`,
      };
    }

    const target = TARGETS.find(([pattern]) => pattern.test(requested))?.[1] ?? requested;
    const operation = REMOVE.test(requested)
      ? "remove-and-repair"
      : REPAIR.test(requested) ? "repair" : "edit";
    const policy = STRENGTH_POLICY[input.strength];
    const compiledPrompt = operation === "remove-and-repair"
      ? (() => {
          const removalTarget = englishTarget(requested, target);
          const removalSubject = /hair|bun/iu.test(removalTarget)
            ? `${removalTarget} and every hair strand inside the selected area`
            : removalTarget;
          const residual = /hair|bun/iu.test(removalTarget)
            ? "No hair, bun, or unwanted object may remain."
            : "No unwanted object or trace may remain.";
          return `OBJECT REMOVAL. User's exact instruction: ${requested}. The user explicitly wants to completely remove: ${removalTarget}. Completely remove ${removalSubject}. Reconstruct the missing anatomy or background naturally. Extend the surrounding background into the selected area with matching color, texture, lighting and perspective. Do not create a replacement object. ${policy} ${residual} Do not preserve the unwanted feature and do not leave traces. Preserve identity and unrelated details outside the selected area.`;
        })()
      : `User's exact instruction: ${requested}. ${policy} Follow the instruction as the primary objective. Preserve identity and unrelated details unless the instruction asks to change them.`;
    return {
      operation,
      target,
      strength: input.strength,
      preserve,
      compiledPrompt,
    };
  }
}
