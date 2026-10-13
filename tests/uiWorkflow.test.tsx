import { readFileSync } from "node:fs";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  CloudRecordsPage,
  GenerateAction,
  GlobalOverlays,
  ModelSettings,
  OutputControls,
  PanelHeader,
  PromptField,
  ReferenceImages,
  Results,
  WriteRecovery,
} from "../src/components/Shared";
import { PluginPanel } from "../src/PluginPanel";
import { createXinbaoSnapshot } from "../src/backend/providerCapabilities";
import { addFavoritePrompt } from "../src/promptNotebookStorage";
import type { PrototypeController } from "../src/usePrototypeState";
import type { Candidate, GenerationDraft, PromptHistoryEntry, PromptNote } from "../src/types";

const draft: GenerationDraft = {
  mode: "text",
  prompt: "",
  model: "auto",
  resolution: "2K",
  quality: "high",
  count: 3,
  aspectRatio: "auto",
  customWidth: 1,
  customHeight: 1,
  outputTarget: "new-document",
  references: [],
};

const snapshot = createXinbaoSnapshot(true);

function controller(
  patch: Partial<PrototypeController> = {},
): PrototypeController {
  return {
    runtimeMode: "browser",
    draft,
    validationMessage: "",
    status: "idle",
    stage: "idle",
    progress: 0,
    elapsedSeconds: 0,
    startGeneration: vi.fn(),
    cancelGeneration: vi.fn(),
    updateDraft: vi.fn(),
    setCount: vi.fn(),
    addReferences: vi.fn(),
    addSelectionReference: vi.fn(),
    referenceCaptureStatus: "idle",
    pickReferenceFiles: vi.fn(),
    reorderReference: vi.fn(),
    removeReference: vi.fn(),
    clearReferences: vi.fn(),
    workspaceView: "config",
    candidates: [],
    outputRatio: "1:1",
    resolvedModel: "gpt-image-2-oai",
    currentModelCapability: snapshot.models[0],
    balance: { status: "idle", unit: "积分" },
    settings: {
      baseUrl: "https://async.xinbao-ai.com",
      apiKey: "key",
      modelOptions: ["auto", "gpt-image-2-oai", "gpt-image-2"],
      connectionStatus: "connected",
      providerSnapshot: snapshot,
    },
    promptNotes: [],
    promptHistory: [],
    favoritePrompt: vi.fn(),
    deletePromptNote: vi.fn(),
    renameNote: vi.fn(),
    applyPromptNote: vi.fn(),
    applyPromptHistory: vi.fn(),
    deletePromptHistory: vi.fn(),
    clearPromptHistory: vi.fn(),
    setSettingsOpen: vi.fn(),
    setCloudRecordsOpen: vi.fn(),
    refreshBalance: vi.fn(),
    ...patch,
  } as unknown as PrototypeController;
}

function note(id: string, prompt: string, title = prompt): PromptNote {
  return { id, title, prompt, mode: "all", pinned: false, order: 0, createdAt: 1, updatedAt: 1, useCount: 0, lastUsedAt: 0 };
}

function history(id: string, prompt: string): PromptHistoryEntry {
  return { id, prompt, mode: "text", lastUsedAt: 1 };
}

const textOf = (node: ReactTestInstance): string => node.children
  .map((child) => typeof child === "string" ? child : textOf(child))
  .join("");

const buttonByText = (root: ReactTestInstance, text: string) => root.find((node) => (
  node.type === "button" && textOf(node).includes(text)
));

/** Prompt box wired to real state so typing, filling and undo behave as in the panel. */
function StatefulPrompt({ initialPrompt = "", notes = [], recent = [], spies }: {
  initialPrompt?: string;
  notes?: PromptNote[];
  recent?: PromptHistoryEntry[];
  spies: Partial<PrototypeController>;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [saved, setSaved] = useState(notes);
  return <PromptField controller={controller({
    draft: { ...draft, prompt },
    promptNotes: saved,
    promptHistory: recent,
    updateDraft: (patch: Partial<GenerationDraft>) => { if (patch.prompt !== undefined) setPrompt(patch.prompt); },
    applyPromptNote: (id: string) => setPrompt(saved.find((item) => item.id === id)?.prompt ?? ""),
    applyPromptHistory: (id: string) => setPrompt(recent.find((item) => item.id === id)?.prompt ?? ""),
    favoritePrompt: (text: string) => { spies.favoritePrompt?.(text); setSaved((current) => addFavoritePrompt(current, text, 5)); },
    deletePromptNote: (id: string) => { spies.deletePromptNote?.(id); setSaved((current) => current.filter((item) => item.id !== id)); },
    renameNote: spies.renameNote ?? vi.fn(),
    deletePromptHistory: spies.deletePromptHistory ?? vi.fn(),
    clearPromptHistory: spies.clearPromptHistory ?? vi.fn(),
  })} />;
}

describe("prompt box and saved prompts", () => {
  it("favorites the typed prompt in one click and shows it as a chip", () => {
    const favoritePrompt = vi.fn();
    const deletePromptNote = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<StatefulPrompt initialPrompt="  换成蓝底  " spies={{ favoritePrompt, deletePromptNote }} />); });
    expect(textOf(tree.root)).toContain("写好后点「☆ 收藏」");

    act(() => buttonByText(tree.root, "收藏").props.onClick());
    expect(favoritePrompt).toHaveBeenCalledWith("换成蓝底");
    const chip = tree.root.find((node) => node.type === "button" && String(node.props.className).includes("prompt-chip is-current"));
    expect(textOf(chip)).toBe("换成蓝底");
    const star = buttonByText(tree.root, "已收藏");
    expect(star.props["aria-pressed"]).toBe(true);

    act(() => star.props.onClick());
    expect(deletePromptNote).toHaveBeenCalledOnce();
    expect(textOf(tree.root)).toContain("写好后点「☆ 收藏」");
    act(() => tree.unmount());
  });

  it("fills the box from a chip and offers to undo replacing typed text", () => {
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<StatefulPrompt initialPrompt="我刚打的字" notes={[note("blue", "把背景换成纯蓝色", "换蓝底")]} spies={{}} />); });
    act(() => buttonByText(tree.root, "换蓝底").props.onClick());
    expect(tree.root.findByType("textarea").props.value).toBe("把背景换成纯蓝色");

    act(() => buttonByText(tree.root, "撤销").props.onClick());
    expect(tree.root.findByType("textarea").props.value).toBe("我刚打的字");
    expect(tree.root.findAll((node) => node.type === "button" && textOf(node).includes("撤销"))).toHaveLength(0);

    act(() => tree.root.findByProps({ "aria-label": "清空提示词" }).props.onClick());
    expect(tree.root.findByType("textarea").props.value).toBe("");
    act(() => tree.root.findByType("textarea").props.onChange({ target: { value: "新内容" } }));
    expect(tree.root.findAll((node) => node.type === "button" && textOf(node).includes("撤销"))).toHaveLength(0);
    act(() => tree.unmount());
  });

  it("shows at most six chips and keeps everything else one click away", () => {
    const notes = Array.from({ length: 8 }, (_, index) => note(`n${index}`, `提示词 ${index}`));
    const html = renderToStaticMarkup(<PromptField controller={controller({ promptNotes: notes })} />);
    expect(html.match(/class="prompt-chip (?!prompt-chip--more)/g)).toHaveLength(6);
    expect(html).toContain("更多…");
    expect(html).not.toContain("prompt-library");
  });

  it("lists favorites and recent prompts inline, renames, and confirms deletions", () => {
    const renameNote = vi.fn();
    const deletePromptHistory = vi.fn();
    const clearPromptHistory = vi.fn();
    const deletePromptNote = vi.fn();
    const favoritePrompt = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<StatefulPrompt
      notes={[note("fav", "已收藏的那条", "收藏名")]}
      recent={[history("h-fav", "已收藏的那条"), history("h1", "最近用过的提示词")]}
      spies={{ renameNote, deletePromptHistory, clearPromptHistory, deletePromptNote, favoritePrompt }}
    />); });
    act(() => buttonByText(tree.root, "更多…").props.onClick());
    const library = tree.root.findByProps({ className: "prompt-library" });
    expect(textOf(library)).toContain("收藏 · 1");
    expect(textOf(library)).toContain("最近用过");
    // A favorite is not repeated under recent prompts.
    expect(textOf(library).match(/已收藏的那条/g)).toHaveLength(1);

    act(() => tree.root.findByProps({ "aria-label": "给「收藏名」改名" }).props.onClick());
    const input = tree.root.findByProps({ "aria-label": "收藏名称" });
    act(() => input.props.onChange({ target: { value: "证件照" } }));
    act(() => tree.root.findByProps({ "aria-label": "收藏名称" }).props.onKeyDown({ key: "Enter" }));
    expect(renameNote).toHaveBeenCalledWith("fav", "证件照");

    act(() => tree.root.findByProps({ "aria-label": "删除这条记录" }).props.onClick());
    expect(deletePromptHistory).toHaveBeenCalledWith("h1");
    act(() => tree.root.findByProps({ "aria-label": "收藏这条" }).props.onClick());
    expect(favoritePrompt).toHaveBeenCalledWith("最近用过的提示词");

    act(() => tree.root.findByProps({ "aria-label": "删除「收藏名」" }).props.onClick());
    expect(deletePromptNote).not.toHaveBeenCalled();
    act(() => tree.root.findByProps({ "aria-label": "确认删除「收藏名」" }).props.onClick());
    expect(deletePromptNote).toHaveBeenCalledWith("fav");

    act(() => buttonByText(tree.root, "清空最近记录").props.onClick());
    expect(clearPromptHistory).not.toHaveBeenCalled();
    act(() => buttonByText(tree.root, "确认清空最近记录").props.onClick());
    expect(clearPromptHistory).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });

  it("fills a recent prompt and closes the list", () => {
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<StatefulPrompt recent={[history("h1", "最近用过的提示词")]} spies={{}} />); });
    act(() => buttonByText(tree.root, "最近用过…").props.onClick());
    act(() => tree.root.find((node) => node.type === "button" && node.props.className === "prompt-row__main").props.onClick());
    expect(tree.root.findByType("textarea").props.value).toBe("最近用过的提示词");
    expect(tree.root.findAll((node) => node.props.className === "prompt-library")).toHaveLength(0);
    act(() => tree.unmount());
  });

  it("keeps the notebook inside the main form instead of a separate page", () => {
    const html = renderToStaticMarkup(<PluginPanel controller={controller({ promptNotes: [note("a", "一条")] })} />);
    expect(html).toContain("prompt-shortcuts");
    expect(html).not.toContain("prompt-notebook-page");
    expect(readFileSync("src/components/Shared.tsx", "utf8")).not.toContain("PromptNotebookPage");
  });
});

describe("output and model settings", () => {
  it("offers presets and a destination in text mode, without the unusable custom ratio", () => {
    const html = renderToStaticMarkup(<OutputControls controller={controller()} />);
    expect(html).toContain("比例");
    expect(html).toContain("放到");
    expect(html).toContain("新建文档");
    expect(html).not.toContain("自定义");
    expect(html).not.toContain("API");
  });

  it("states that image-to-image sends the current canvas and follows its ratio", () => {
    const html = renderToStaticMarkup(<OutputControls controller={controller({
      draft: { ...draft, mode: "redraw" },
      outputRatio: "3:2",
    })} />);
    expect(html).toContain("跟随文档 3:2");
    expect(html).toContain("会把当前文档的画面一起发给心宝");
  });

  it("folds model, size and quality into one summary line with friendly names", () => {
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<ModelSettings controller={controller()} />); });
    const summary = tree.root.findByProps({ className: "summary-button" });
    expect(textOf(summary)).toBe("G-2.0 OAI · 2K · 精细修改");
    expect(tree.root.findAllByProps({ "aria-label": "模型" })).toHaveLength(0);

    act(() => summary.props.onClick());
    const body = textOf(tree.root);
    expect(body).toContain("G-2.0 OAI · 12 积分/张");
    expect(body).toContain("1K 到 4K、两档画质都是同一个价");
    expect(body).not.toContain("自动选择");
    act(() => tree.root.findByProps({ "aria-label": "画质" }).props.onClick());
    expect(textOf(tree.root.findByProps({ role: "listbox" }))).toBe("精细（较慢）标准（较快）");
    act(() => tree.unmount());
  });

  it("warns that G-2.0 stops near 1.5K and hides the quality choice it ignores", () => {
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<ModelSettings controller={controller({
      draft: { ...draft, model: "gpt-image-2" },
      resolvedModel: "gpt-image-2",
      currentModelCapability: snapshot.models[1],
    })} />); });
    act(() => tree.root.findByProps({ className: "summary-button" }).props.onClick());
    expect(textOf(tree.root)).toContain("G-2.0 实测最大约 1.5K");
    expect(tree.root.findAllByProps({ "aria-label": "画质" })).toHaveLength(0);
    act(() => tree.root.findByProps({ "aria-label": "清晰度" }).props.onClick());
    expect(textOf(tree.root.findByProps({ role: "listbox" }))).toBe("1K2K");
    act(() => tree.unmount());
  });
});

describe("generate bar", () => {
  it("puts the single blocker inside the disabled button", () => {
    const html = renderToStaticMarkup(<GenerateAction controller={controller({ validationMessage: "请先填写提示词" })} />);
    expect(html).toMatch(/<button class="generate-button"[^>]*disabled=""[^>]*>请先填写提示词<\/button>/);
  });

  it("shows count and estimated points next to the count stepper", () => {
    const startGeneration = vi.fn();
    const setCount = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<GenerateAction controller={controller({ pointEstimate: 36, startGeneration, setCount })} />); });
    const button = tree.root.findByProps({ className: "generate-button" });
    expect(textOf(button)).toBe("生成 3 张 · 约 36 积分");
    act(() => button.props.onClick());
    expect(startGeneration).toHaveBeenCalledOnce();
    act(() => tree.root.findByProps({ "aria-label": "增加生成数量" }).props.onClick());
    act(() => tree.root.findByProps({ "aria-label": "减少生成数量" }).props.onClick());
    expect(setCount.mock.calls).toEqual([[4], [2]]);
    act(() => tree.unmount());
  });

  it("bounds the count between one and four", () => {
    const low = renderToStaticMarkup(<GenerateAction controller={controller({ draft: { ...draft, count: 1 } })} />);
    expect(low).toMatch(/aria-label="减少生成数量" disabled=""/);
    const high = renderToStaticMarkup(<GenerateAction controller={controller({ draft: { ...draft, count: 4 } })} />);
    expect(high).toMatch(/aria-label="增加生成数量" disabled=""/);
    const uxp = renderToStaticMarkup(<GenerateAction controller={controller({ runtimeMode: "uxp" })} />);
    expect(uxp).toContain("count-stepper__value--static");
  });

  it("shows waiting time instead of a made-up percentage and can cancel", () => {
    const cancelGeneration = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<GenerateAction controller={controller({
      status: "running",
      stage: "generating",
      progress: 27,
      elapsedSeconds: 65,
      cancelGeneration,
    })} />); });
    const text = textOf(tree.root);
    expect(text).toContain("心宝生成中 · 已等 1:05");
    expect(text).toContain("通常 1–5 分钟");
    expect(text).not.toContain("%");
    act(() => buttonByText(tree.root, "取消").props.onClick());
    expect(cancelGeneration).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });

  it("keeps the generate bar outside the scrolling form", () => {
    const html = renderToStaticMarkup(<PluginPanel controller={controller()} />);
    expect(html).toMatch(/<\/div><footer class="panel-action-bar">/);
  });
});

describe("results", () => {
  const candidates: Candidate[] = [1, 2, 3].map((index) => ({
    id: `c${index}`,
    title: `第 ${index} 张`,
    url: `blob:c${index}`,
    aspectRatio: "1:1",
    selected: index === 1,
    outputTarget: "current-document",
  }));

  it("keeps the previewed image by default and labels the keep button by count", () => {
    const one = renderToStaticMarkup(<Results controller={controller({ runtimeMode: "uxp", candidates, activeCandidateId: "c1" })} />);
    expect(one).toContain("保留这张");
    expect(one).toContain("点图片在 PS 里预览；想多留几张就勾选");
    expect(one).toContain("第 1 张 · 预览中");

    const two = renderToStaticMarkup(<Results controller={controller({
      candidates: candidates.map((item) => ({ ...item, selected: item.id !== "c3" })),
      activeCandidateId: "c1",
    })} />);
    expect(two).toContain("保留 2 张");

    const none = renderToStaticMarkup(<Results controller={controller({
      candidates: candidates.map((item) => ({ ...item, selected: false })),
      activeCandidateId: "c1",
    })} />);
    expect(none).toMatch(/<button class="insert-button"[^>]*disabled=""/);
    expect(none).toContain("勾选要保留的图");
  });

  it("separates ticking from previewing and can drop the whole batch", () => {
    const toggleCandidate = vi.fn();
    const activateCandidate = vi.fn();
    const returnToConfiguration = vi.fn();
    const insertSelected = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<Results controller={controller({
      candidates,
      activeCandidateId: "c1",
      toggleCandidate,
      activateCandidate,
      returnToConfiguration,
      insertSelected,
      setPreviewCandidate: vi.fn(),
    })} />); });
    act(() => tree.root.findByProps({ "aria-label": "保留第 2 张" }).props.onClick());
    expect(toggleCandidate).toHaveBeenCalledWith("c2");
    act(() => tree.root.findByProps({ alt: "第 3 张" }).props.onClick());
    expect(activateCandidate).toHaveBeenCalledWith("c3");
    act(() => buttonByText(tree.root, "保留这张").props.onClick());
    expect(insertSelected).toHaveBeenCalledOnce();
    act(() => buttonByText(tree.root, "全不要").props.onClick());
    expect(returnToConfiguration).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });

  it("offers a plain retry when a finished image could not be placed", () => {
    const retryGeneratedWrite = vi.fn();
    const discardGeneratedResult = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<WriteRecovery controller={controller({
      workspaceView: "write-recovery",
      writeStatus: "failed",
      writeError: "Photoshop 当前文档不可写",
      candidates: [candidates[0]],
      retryGeneratedWrite,
      discardGeneratedResult,
    })} />); });
    expect(textOf(tree.root)).toContain("图片已生成，还没放进文档");
    expect(textOf(tree.root)).toContain("Photoshop 当前文档不可写");
    act(() => buttonByText(tree.root, "再试一次").props.onClick());
    act(() => buttonByText(tree.root, "不要了").props.onClick());
    expect(retryGeneratedWrite).toHaveBeenCalledOnce();
    expect(discardGeneratedResult).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });
});

describe("header and settings", () => {
  it("names the connection plainly and keeps balance details in the tooltip", () => {
    const connected = renderToStaticMarkup(<PanelHeader controller={controller({
      balance: { status: "available", unit: "积分", remaining: 1_490_000, total: 20_000_000, updatedAt: new Date(2026, 6, 27, 19, 37, 55).getTime() },
    })} />);
    expect(connected).toContain("已连接");
    expect(connected).toContain("149万 积分");
    expect(connected).toContain("上次更新");
    expect(connected).not.toContain("API");

    const noKey = renderToStaticMarkup(<PanelHeader controller={controller({
      settings: { ...controller().settings, apiKey: "" },
    })} />);
    expect(noKey).toContain("未填 Key");
  });

  it("keeps settings to the account, remembered settings and appearance", () => {
    const saveApiKey = vi.fn();
    const testConnection = vi.fn();
    const setRememberLastSettings = vi.fn();
    const restoreDefaultGenerationSettings = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<GlobalOverlays controller={controller({
      runtimeMode: "uxp",
      settingsOpen: true,
      credentialSaveStatus: "idle",
      rememberLastSettings: true,
      generationSettingsReady: true,
      theme: "graphite",
      setTheme: vi.fn(),
      setSettings: vi.fn(),
      saveApiKey,
      testConnection,
      setRememberLastSettings,
      restoreDefaultGenerationSettings,
    })} />); });
    const text = textOf(tree.root);
    expect(text).toContain("心宝账号");
    expect(text).toContain("接口地址");
    expect(text).toContain("记住上次的设置");
    expect(text).not.toContain("刷新模型");
    expect(text).not.toContain("能力来源");
    expect(text).not.toContain("Base URL");
    act(() => buttonByText(tree.root, "保存").props.onClick());
    act(() => tree.root.findByProps({ "aria-label": "检测连接" }).props.onClick());
    act(() => tree.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: false } }));
    act(() => buttonByText(tree.root, "恢复默认设置").props.onClick());
    expect(saveApiKey).toHaveBeenCalledOnce();
    expect(testConnection).toHaveBeenCalledOnce();
    expect(setRememberLastSettings).toHaveBeenCalledWith(false);
    expect(restoreDefaultGenerationSettings).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });
});

describe("cloud records", () => {
  const records = (patch: Partial<PrototypeController> = {}) => controller({
    cloudRecordsStatus: "ready",
    cloudRecordsError: null,
    cloudRecords: [],
    cloudTaskImages: {},
    refreshCloudTasks: vi.fn(),
    loadCloudTaskImage: vi.fn(),
    ...patch,
  });

  it("renders loading, empty and error states, and sends a missing key to settings", () => {
    expect(renderToStaticMarkup(<CloudRecordsPage controller={records({ cloudRecordsStatus: "idle" })} />)).toContain("正在准备云端记录");
    expect(renderToStaticMarkup(<CloudRecordsPage controller={records()} />)).toContain("最近 3 天没有生成记录");
    const stale = renderToStaticMarkup(<CloudRecordsPage controller={records({ cloudRecordsStatus: undefined })} />);
    expect(stale).toContain('data-cloud-records-status="loading"');
    expect(() => renderToStaticMarkup(<CloudRecordsPage controller={records({ cloudRecords: undefined, cloudTaskImages: undefined })} />)).not.toThrow();

    const failed = renderToStaticMarkup(<CloudRecordsPage controller={records({ cloudRecordsStatus: "error", cloudRecordsError: "云端记录鉴权失败（401）" })} />);
    expect(failed).toContain("云端记录鉴权失败（401）");
    expect(failed).toContain(">重试</button>");

    const setCloudRecordsOpen = vi.fn();
    const setSettingsOpen = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<CloudRecordsPage controller={records({
      cloudRecordsStatus: "error",
      cloudRecordsError: "请先在设置里填好 Key",
      settings: { ...controller().settings, apiKey: "" },
      setCloudRecordsOpen,
      setSettingsOpen,
    })} />); });
    act(() => buttonByText(tree.root, "去设置").props.onClick());
    expect(setCloudRecordsOpen).toHaveBeenCalledWith(false);
    expect(setSettingsOpen).toHaveBeenCalledWith(true);
    act(() => tree.unmount());
  });

  it("shows the prompt and the model's own name on each card and retries thumbnails", () => {
    const loadCloudTaskImage = vi.fn();
    const task = {
      taskId: "task-plugin-1",
      model: "gpt-image-2-oai",
      status: "succeeded",
      createdAt: Date.now(),
      completedAt: Date.now(),
      thumbnailUrl: "https://cdn.example/task.png",
      prompt: "一只橘猫坐在窗台上",
      origin: "plugin" as const,
    };
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<CloudRecordsPage controller={records({ cloudRecords: [task], loadCloudTaskImage })} />); });
    expect(loadCloudTaskImage).toHaveBeenCalledWith(task);
    act(() => { tree.update(<CloudRecordsPage controller={records({
      cloudRecords: [task],
      cloudTaskImages: { [task.taskId]: { status: "error", error: "图片下载失败（503）" } },
      loadCloudTaskImage,
    })} />); });
    const meta = tree.root.findByProps({ className: "cloud-task__meta" });
    expect(textOf(meta)).toContain("G-2.0 OAI");
    expect(textOf(meta)).toContain("一只橘猫坐在窗台上");
    expect(textOf(meta)).not.toContain("task-plugin-1");
    act(() => tree.root.findByProps({ "aria-label": "重试任务 task-plugin-1 图片" }).props.onClick());
    expect(loadCloudTaskImage).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it("paginates twelve cards at a time", () => {
    const tasks = Array.from({ length: 13 }, (_, index) => ({
      taskId: `task-${index + 1}`,
      model: "model",
      status: "succeeded",
      createdAt: Date.now() - index,
      completedAt: null,
      thumbnailUrl: `https://cdn.example/${index + 1}.png`,
      origin: "external-or-unknown" as const,
    }));
    const loadCloudTaskImage = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<CloudRecordsPage controller={records({ cloudRecords: tasks, loadCloudTaskImage })} />); });
    expect(tree.root.findAllByType("article")).toHaveLength(12);
    act(() => tree.root.findByProps({ title: "下一页" }).props.onClick());
    expect(tree.root.findAllByType("article")).toHaveLength(1);
    expect(tree.root.findByType("article").props.title).toContain("task-13");
    expect(loadCloudTaskImage).toHaveBeenCalledTimes(13);
    act(() => tree.unmount());
  });
});

describe("reference images", () => {
  const reference = (id: string) => ({
    id,
    name: `${id}.png`,
    url: `blob:${id}`,
    order: 0,
    file: new File(["image"], `${id}.png`, { type: "image/png" }),
  });

  it("labels the selection button as a screenshot, not as editing the selection", () => {
    const html = renderToStaticMarkup(<ReferenceImages controller={controller()} />);
    expect(html).toContain("参考图 · 可选");
    expect(html).toContain("选区截图");
    expect(html).toContain("不会只改选区");
  });

  it("uses the UXP picker and the selection capture, and stops at nine", () => {
    const pickReferenceFiles = vi.fn();
    const addSelectionReference = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<ReferenceImages controller={controller({ runtimeMode: "uxp", pickReferenceFiles, addSelectionReference })} />); });
    act(() => tree.root.findByProps({ "aria-label": "添加参考图" }).props.onClick());
    act(() => tree.root.findByProps({ "aria-label": "添加当前选区" }).props.onClick());
    expect(pickReferenceFiles).toHaveBeenCalledOnce();
    expect(addSelectionReference).toHaveBeenCalledOnce();
    act(() => tree.unmount());

    const full = renderToStaticMarkup(<ReferenceImages controller={controller({
      draft: { ...draft, references: Array.from({ length: 9 }, (_, index) => reference(`r${index}`)) },
    })} />);
    expect(full).toContain("参考图 9/9");
    expect(full).toMatch(/aria-label="添加参考图"[^>]*disabled=""/);
  });

  it("routes browser file input and explicit deletion through the controller", () => {
    const addReferences = vi.fn();
    const removeReference = vi.fn();
    const clearReferences = vi.fn();
    const file = new File(["image"], "drop.png", { type: "image/png" });
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<ReferenceImages controller={controller({
      draft: { ...draft, references: [reference("ref-delete")] },
      addReferences,
      removeReference,
      clearReferences,
    })} />); });
    const inputEvent = { target: { files: [file], value: "selected" } };
    act(() => tree.root.findByType("input").props.onChange(inputEvent));
    expect(addReferences.mock.calls).toEqual([[[file]]]);
    expect(inputEvent.target.value).toBe("");
    const stopPropagation = vi.fn();
    act(() => tree.root.findByProps({ "aria-label": "删除参考图" }).props.onClick({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(removeReference).toHaveBeenCalledWith("ref-delete");
    act(() => tree.root.findByProps({ "aria-label": "清空参考图" }).props.onClick());
    expect(clearReferences).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });

  it("reorders thumbnails by dragging across rows", () => {
    const reorderReference = vi.fn();
    const references = Array.from({ length: 6 }, (_, index) => reference(`wrap-${index}`));
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<ReferenceImages controller={controller({ draft: { ...draft, references }, reorderReference })} />); });
    const items = tree.root.findAll((node) => node.type === "div" && String(node.props.className).includes("reference-item"));
    const centers = [[28, 28], [89, 28], [150, 28], [211, 28], [28, 89], [89, 89]];
    const children = centers.map(([x, y]) => ({ getBoundingClientRect: () => ({ left: x - 28, top: y - 28, width: 56, height: 56 }) }));
    act(() => items[1].props.onMouseDown({ button: 0, clientX: 89, clientY: 28, currentTarget: { parentElement: { children } }, preventDefault: vi.fn() }));
    act(() => tree.root.findByProps({ className: "reference-list" }).props.onMouseMove({ clientX: 89, clientY: 89 }));
    expect(items[1].props.style.transform).toBe("translate(0px, 61px) scale(.94)");
    act(() => tree.root.findByType("section").props.onMouseUp());
    expect(reorderReference).toHaveBeenCalledWith("wrap-1", 5);
    act(() => tree.unmount());
  });
});

describe("Photoshop UXP styling contract", () => {
  const css = readFileSync("src/styles.css", "utf8");
  const source = readFileSync("src/components/Shared.tsx", "utf8");

  it("never uses CSS grid, which UXP does not lay out", () => {
    expect(css).not.toMatch(/display:\s*grid/);
    expect(css).not.toMatch(/grid-template/);
  });

  it("keeps every font size readable next to Photoshop's own panels", () => {
    const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10);
    expect(css).toMatch(/--fs-body:\s*12px/);
    expect(css).toMatch(/--fs-hint:\s*11px/);
  });

  it("keeps dropdown menus out of layout flow and without decorative arrows", () => {
    expect(css).toMatch(/\.uxp-dropdown\s*\{[^}]*position:\s*relative/s);
    expect(css).toMatch(/\.uxp-dropdown__list\s*\{[^}]*position:\s*absolute/s);
    expect(css).not.toContain("uxp-dropdown__arrow");
  });

  it("anchors overlays inside the panel and paints viewport layers opaquely", () => {
    expect(css).toMatch(/body\.uxp-shell \.overlay\s*\{[^}]*position:\s*absolute/s);
    expect(css).toMatch(/body\.uxp-shell \.dock-panel\s*\{[^}]*background-color:\s*var\(--panel\)/s);
    expect(css).toMatch(/body\.uxp-shell \.plugin-panel\.is-resizing/);
  });

  it("draws icons as text glyphs rather than images UXP may fail to decode", () => {
    expect(source).toContain("const UXP_ICONS");
    expect(source).not.toMatch(/<svg|<img[^>]*icon/);
  });

  it("no longer carries the removed reference strength control", () => {
    for (const file of ["src/types.ts", "src/usePrototypeState.ts", "src/documentSessionState.ts", "src/components/Shared.tsx"]) {
      expect(readFileSync(file, "utf8")).not.toContain("referenceStrength");
    }
  });
});
