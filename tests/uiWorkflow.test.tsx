import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  GenerateAction,
  CloudRecordsPage,
  DetailParameters,
  GlobalOverlays,
  ModeTabs,
  OutputControls,
  PanelHeader,
  PromptField,
  PromptNotebookPage,
  ReferenceImages,
  WriteRecovery,
} from "../src/components/Shared";
import { PluginPanel } from "../src/PluginPanel";
import type { PrototypeController } from "../src/usePrototypeState";
import type { GenerationDraft, PromptNote } from "../src/types";

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
    workspaceView: "configuration",
    candidates: [],
    outputRatio: "1:1",
    balance: { status: "idle", unit: "积分" },
    settings: {
      baseUrl: "https://async.xinbao-ai.com",
      apiKey: "",
      modelOptions: ["gpt-image-2-oai"],
      connectionStatus: "connected",
      providerSnapshot: null,
    },
    setSettingsOpen: vi.fn(),
    refreshBalance: vi.fn(),
    ...patch,
  } as unknown as PrototypeController;
}

describe("compact workflow UI", () => {
  const notebookNotes: PromptNote[] = [{
    id: "note-garden",
    title: "黄昏花海",
    prompt: "柔和黄昏光里的紫色花海",
    mode: "all",
    pinned: true,
    order: 0,
    createdAt: 1,
    updatedAt: 1,
  }, {
    id: "note-cat",
    title: "黑猫",
    prompt: "一只安静的黑猫，柔和侧光",
    mode: "text",
    pinned: false,
    order: 1,
    createdAt: 1,
    updatedAt: 1,
  }];

  it("shows a dedicated single-image write recovery without candidate interactions", () => {
    const retryGeneratedWrite = vi.fn();
    const discardGeneratedResult = vi.fn();
    const html = renderToStaticMarkup(<WriteRecovery controller={controller({
      workspaceView: "write-recovery",
      generationResultStatus: "succeeded",
      writeStatus: "failed",
      writeError: "Photoshop 当前文档不可写",
      candidates: [{
        id: "single",
        title: "单图",
        url: "blob:single",
        aspectRatio: "1:1",
        selected: true,
      }],
      retryGeneratedWrite,
      discardGeneratedResult,
    })} />);

    expect(html).toContain("图片已生成，重试写入");
    expect(html).toContain("Photoshop 当前文档不可写");
    expect(html).not.toContain("candidate-select");
    expect(html).not.toContain("保留当前候选");
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<WriteRecovery controller={controller({
      workspaceView: "write-recovery",
      writeStatus: "failed",
      writeError: "Photoshop 当前文档不可写",
      candidates: [],
      retryGeneratedWrite,
      discardGeneratedResult,
    })} />); });
    const buttons = tree.root.findAllByType("button");
    act(() => buttons[0].props.onClick());
    act(() => buttons[1].props.onClick());
    expect(retryGeneratedWrite).toHaveBeenCalledOnce();
    expect(discardGeneratedResult).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });

  it("renders custom aspect ratio as a ratio pair, never as pixel dimensions", () => {
    const html = renderToStaticMarkup(<OutputControls controller={controller({
      draft: { ...draft, aspectRatio: "custom", customWidth: 5, customHeight: 4 },
      outputRatio: "5:4",
      currentModelCapability: { aspectRatios: ["1:1"] },
      setCustomDimension: vi.fn(),
    })} compact />);
    expect(html).toContain('aria-label="自定义比例宽"');
    expect(html).toContain('aria-label="自定义比例高"');
    expect(html).toContain("自定义比例 5:4");
    expect(html).not.toContain("px");
  });

  it("opens the prompt notebook as an independent page and filters notes", () => {
    const controllerValue = controller({
      promptNotes: notebookNotes,
      promptNotesReady: true,
      savePromptNote: vi.fn(),
      deletePromptNote: vi.fn(),
      togglePromptNotePinned: vi.fn(),
      reorderPromptNote: vi.fn(),
    });
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<PromptNotebookPage controller={controllerValue} onClose={vi.fn()} />); });
    expect(tree.root.findByProps({ role: "dialog" })).toBeTruthy();
    expect(tree.root.findAllByType("article")).toHaveLength(2);
    const search = tree.root.findByProps({ "aria-label": "搜索提示词" });
    act(() => search.props.onChange({ target: { value: "黑猫" } }));
    expect(tree.root.findAllByType("article")).toHaveLength(1);
    expect(tree.root.findByProps({ "aria-label": "使用黑猫" })).toBeTruthy();
    act(() => tree.unmount());
  });

  it("keeps automatic history separate from favorites with use, delete and clear actions", () => {
    const updateDraft = vi.fn();
    const deletePromptHistory = vi.fn();
    const clearPromptHistory = vi.fn();
    const onClose = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<PromptNotebookPage controller={controller({
      promptNotes: notebookNotes,
      promptNotesReady: true,
      promptHistoryReady: true,
      promptHistory: [{ id: "history-a", prompt: "历史白花", mode: "text", lastUsedAt: 2 }, { id: "history-b", prompt: "历史修复", mode: "redraw", lastUsedAt: 1 }],
      updateDraft,
      deletePromptHistory,
      clearPromptHistory,
    })} onClose={onClose} />); });
    expect(tree.root.findAllByType("article")).toHaveLength(2);
    const historyTab = tree.root.findAllByProps({ role: "tab" }).find((tab) => tab.props.children === "历史");
    act(() => historyTab!.props.onClick());
    expect(tree.root.findByProps({ "aria-label": "搜索提示词历史" })).toBeTruthy();
    expect(tree.root.findAllByType("article")).toHaveLength(2);
    act(() => tree.root.findByProps({ "aria-label": "使用历史历史白花" }).props.onClick());
    expect(updateDraft).toHaveBeenCalledWith({ prompt: "历史白花" });
    expect(onClose).toHaveBeenCalledOnce();
    act(() => tree.root.findByProps({ "aria-label": "删除历史历史修复" }).props.onClick());
    expect(deletePromptHistory).toHaveBeenCalledWith("history-b");
    const clear = tree.root.findAllByType("button").find((button) => button.props.children === "清空历史");
    act(() => clear!.props.onClick());
    const confirm = tree.root.findAllByType("button").find((button) => button.props.children === "确认清空");
    act(() => confirm!.props.onClick());
    expect(clearPromptHistory).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });

  it("filters notebook modes and supports new and favorite-current drafts", () => {
    const controllerValue = controller({
      draft: { ...draft, mode: "redraw", prompt: "保留这段当前提示词" },
      promptNotes: notebookNotes,
      promptNotesReady: true,
      savePromptNote: vi.fn(),
      deletePromptNote: vi.fn(),
      togglePromptNotePinned: vi.fn(),
      reorderPromptNote: vi.fn(),
    });
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<PromptNotebookPage controller={controllerValue} onClose={vi.fn()} />); });
    act(() => tree.root.findByProps({ "aria-label": "提示词模式筛选" }).props.onChange({ target: { value: "redraw" } }));
    expect(tree.root.findAllByType("article")).toHaveLength(1);
    expect(tree.root.findByProps({ "aria-label": "使用黄昏花海" })).toBeTruthy();

    act(() => tree.root.findByProps({ "aria-label": "新建提示词" }).props.onClick());
    expect(tree.root.findByProps({ "aria-label": "提示词正文" }).props.value).toBe("");
    act(() => tree.root.findByProps({ "aria-label": "返回主配置" }).props.onClick());
    expect(tree.root.findByProps({ className: "prompt-notebook-favorite" })).toBeTruthy();

    act(() => tree.root.findByProps({ className: "prompt-notebook-favorite" }).props.onClick());
    expect(tree.root.findByProps({ "aria-label": "提示词正文" }).props.value).toBe("保留这段当前提示词");
    expect(tree.root.findAllByType("select")).toHaveLength(1);
    expect(tree.root.findByType("select").props.value).toBe("redraw");
    act(() => tree.unmount());
  });

  it("unmounts the main configuration and native selects while the notebook page is open", () => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const controllerValue = controller({
      promptNotes: notebookNotes,
      promptNotesReady: true,
      savePromptNote: vi.fn(),
      deletePromptNote: vi.fn(),
      togglePromptNotePinned: vi.fn(),
      reorderPromptNote: vi.fn(),
    });
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<PluginPanel controller={controllerValue} />); });
    expect(tree.root.findAllByProps({ className: "generate-button" })).toHaveLength(1);
    act(() => tree.root.findByProps({ className: "prompt-notebook-trigger prompt-header-button" }).props.onClick());
    expect(tree.root.findByProps({ role: "dialog", "aria-label": "提示词本" })).toBeTruthy();
    expect(tree.root.findAllByProps({ className: "generate-button" })).toHaveLength(0);
    expect(tree.root.findAllByProps({ "aria-label": "输出比例" })).toHaveLength(0);
    act(() => tree.root.findByProps({ "aria-label": "返回主配置" }).props.onClick());
    expect(tree.root.findAllByProps({ className: "generate-button" })).toHaveLength(1);
    expect(tree.root.findAllByProps({ "aria-label": "输出比例" })).toHaveLength(1);
    act(() => tree.unmount());
    vi.unstubAllGlobals();
  });

  it("restores configuration scroll position after returning from the notebook", () => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const scrollNode = { scrollTop: 0 };
    const controllerValue = controller({
      promptNotes: notebookNotes,
      promptNotesReady: true,
      savePromptNote: vi.fn(),
      deletePromptNote: vi.fn(),
      togglePromptNotePinned: vi.fn(),
      reorderPromptNote: vi.fn(),
    });
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<PluginPanel controller={controllerValue} />, {
        createNodeMock: (element) => element.props.className?.includes("panel-scroll") ? scrollNode : {},
      });
    });
    scrollNode.scrollTop = 137;
    act(() => tree.root.findByProps({ className: "prompt-notebook-trigger prompt-header-button" }).props.onClick());
    scrollNode.scrollTop = 0;
    act(() => tree.root.findByProps({ "aria-label": "返回主配置" }).props.onClick());
    expect(scrollNode.scrollTop).toBe(137);
    act(() => tree.unmount());
    vi.unstubAllGlobals();
  });

  it("uses bounded minus and plus buttons for generation count", () => {
    const setCount = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<DetailParameters controller={controller({
        draft: { ...draft, count: 1 },
        setCount,
      })} />);
    });
    const decrement = tree.root.findByProps({ "aria-label": "减少生成数量" });
    const increment = tree.root.findByProps({ "aria-label": "增加生成数量" });
    expect(decrement.props.disabled).toBe(true);
    act(() => decrement.props.onClick());
    expect(setCount).not.toHaveBeenCalled();
    act(() => increment.props.onClick());
    expect(setCount).toHaveBeenLastCalledWith(2);

    act(() => tree.update(<DetailParameters controller={controller({
      draft: { ...draft, count: 4 },
      setCount,
    })} />));
    expect(tree.root.findByProps({ "aria-label": "增加生成数量" }).props.disabled).toBe(true);
    act(() => tree.root.findByProps({ "aria-label": "增加生成数量" }).props.onClick());
    expect(setCount).not.toHaveBeenCalledWith(5);
    act(() => tree.root.findByProps({ "aria-label": "减少生成数量" }).props.onClick());
    expect(setCount).toHaveBeenLastCalledWith(3);
    act(() => tree.unmount());
  });

  it("allows direct generation count entry while keeping the 1 to 4 bounds", () => {
    const setCount = vi.fn();
    const tree = create(<DetailParameters controller={controller({
      draft: { ...draft, count: 3 },
      setCount,
    })} />);
    const input = tree.root.findByProps({ "aria-label": "直接输入生成数量" });
    expect(input.type).toBe("input");
    expect(input.props.inputMode).toBe("numeric");
    act(() => input.props.onChange({ currentTarget: { value: "4" } }));
    expect(setCount).toHaveBeenLastCalledWith(4);
    act(() => input.props.onChange({ currentTarget: { value: "7" } }));
    expect(setCount).toHaveBeenLastCalledWith(4);
    act(() => input.props.onChange({ currentTarget: { value: "0" } }));
    expect(setCount).toHaveBeenLastCalledWith(1);
    act(() => tree.unmount());
  });

  it("lets the UXP count input absorb its native minimum width without clipping either button", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/body\.uxp-shell \.count-stepper\s*\{[^}]*display:\s*flex/s);
    expect(css).toMatch(/body\.uxp-shell \.count-stepper\s*\{[^}]*width:\s*100%[^}]*overflow:\s*visible/s);
    expect(css).toMatch(/body\.uxp-shell \.count-stepper button\s*\{[^}]*flex:\s*0 0 28px/s);
    expect(css).toMatch(/body\.uxp-shell \.count-stepper__value\s*\{[^}]*flex:\s*1 1 auto[^}]*min-width:\s*40px[^}]*appearance:\s*none/s);
  });

  it("renders the generation count with a plain UXP-safe text input", () => {
    const tree = create(<DetailParameters controller={controller()} />);
    const value = tree.root.findByProps({ className: "count-stepper__value" });
    expect(value.type).toBe("input");
    expect(value.props.type).toBe("text");
    expect(value.props.inputMode).toBe("numeric");
    expect(value.props.maxLength).toBe(1);
    act(() => tree.unmount());
  });

  it("keeps notebook actions working with long content and thirty notes", () => {
    const longPrompt = "细节丰富的生产提示词。".repeat(200);
    const manyNotes = Array.from({ length: 30 }, (_, index): PromptNote => ({
      id: `note-${index}`,
      title: index === 0 ? "这是一个不会撑破窄面板的超长提示词标题".repeat(4) : `提示词 ${index + 1}`,
      prompt: index === 0 ? longPrompt : `正文 ${index + 1}`,
      mode: index % 2 ? "text" : "all",
      pinned: index === 0,
      order: index,
      createdAt: index,
      updatedAt: index,
    }));
    const updateDraft = vi.fn();
    const togglePromptNotePinned = vi.fn();
    const reorderPromptNote = vi.fn();
    const onClose = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<PromptNotebookPage controller={controller({
        draft: { ...draft, prompt: "当前草稿" },
        promptNotes: manyNotes,
        promptNotesReady: true,
        savePromptNote: vi.fn(),
        deletePromptNote: vi.fn(),
        togglePromptNotePinned,
        reorderPromptNote,
        updateDraft,
      })} onClose={onClose} />);
    });
    expect(tree.root.findAllByType("article")).toHaveLength(30);
    act(() => tree.root.findByProps({ "aria-label": `取消置顶${manyNotes[0].title}` }).props.onClick());
    expect(togglePromptNotePinned).toHaveBeenCalledWith("note-0");
    const cards = tree.root.findAllByType("article");
    act(() => cards[0].props.onDragStart());
    act(() => cards[1].props.onDrop());
    expect(reorderPromptNote).toHaveBeenCalledWith("note-0", 1);
    act(() => tree.root.findByProps({ "aria-label": `使用${manyNotes[0].title}` }).props.onClick());
    expect(updateDraft).toHaveBeenCalledWith({ prompt: longPrompt });
    expect(onClose).toHaveBeenCalledOnce();

    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.prompt-notebook-page\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(css).not.toContain(".prompt-notebook-popover");
    act(() => tree.unmount());
  });

  it("confirms unsaved notebook edits before returning", () => {
    const onClose = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<PromptNotebookPage controller={controller({
        promptNotes: notebookNotes,
        promptNotesReady: true,
        savePromptNote: vi.fn(),
        deletePromptNote: vi.fn(),
        togglePromptNotePinned: vi.fn(),
        reorderPromptNote: vi.fn(),
      })} onClose={onClose} />);
    });
    act(() => tree.root.findByProps({ "aria-label": "编辑黑猫" }).props.onClick());
    act(() => tree.root.findByProps({ "aria-label": "提示词正文" }).props.onChange({ target: { value: "尚未保存" } }));
    act(() => tree.root.findByProps({ "aria-label": "返回主配置" }).props.onClick());
    expect(tree.root.findAll((node) => node.type === "span" && node.children.includes("放弃未保存修改？"))).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    act(() => tree.root.findByProps({ "aria-label": "返回主配置" }).props.onClick());
    expect(onClose).not.toHaveBeenCalled();
    act(() => tree.root.findAll((node) => node.type === "button" && node.children.includes("放弃并返回"))[0].props.onClick());
    expect(onClose).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });

  it("routes Escape through the unsaved notebook confirmation", () => {
    let keydownHandler: ((event: KeyboardEvent) => void) | undefined;
    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, handler: (event: KeyboardEvent) => void) => {
        if (type === "keydown") keydownHandler = handler;
      }),
      removeEventListener: vi.fn(),
    });
    const onClose = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<PromptNotebookPage controller={controller({
        promptNotes: notebookNotes,
        promptNotesReady: true,
        savePromptNote: vi.fn(),
        deletePromptNote: vi.fn(),
        togglePromptNotePinned: vi.fn(),
        reorderPromptNote: vi.fn(),
      })} onClose={onClose} />);
    });
    act(() => tree.root.findByProps({ "aria-label": "编辑黑猫" }).props.onClick());
    act(() => tree.root.findByProps({ "aria-label": "提示词正文" }).props.onChange({ target: { value: "Esc 前仍未保存" } }));
    act(() => keydownHandler?.({ key: "Escape" } as KeyboardEvent));
    expect(onClose).not.toHaveBeenCalled();
    expect(tree.root.findAll((node) => node.type === "span" && node.children.includes("放弃未保存修改？"))).toHaveLength(1);
    act(() => tree.unmount());
    vi.unstubAllGlobals();
  });

  it("edits and saves a notebook note without mutating the draft directly", () => {
    const savePromptNote = vi.fn();
    const controllerValue = controller({
      promptNotes: notebookNotes,
      promptNotesReady: true,
      savePromptNote,
      deletePromptNote: vi.fn(),
      togglePromptNotePinned: vi.fn(),
      reorderPromptNote: vi.fn(),
    });
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<PromptNotebookPage controller={controllerValue} onClose={vi.fn()} />); });
    act(() => tree.root.findByProps({ "aria-label": "编辑黑猫" }).props.onClick());
    const title = tree.root.findByProps({ "aria-label": "提示词标题" });
    const body = tree.root.findByProps({ "aria-label": "提示词正文" });
    act(() => title.props.onChange({ target: { value: "夜猫" } }));
    act(() => body.props.onChange({ target: { value: "夜色中的黑猫" } }));
    act(() => tree.root.findByProps({ className: "notebook-save" }).props.onClick());
    expect(savePromptNote).toHaveBeenCalledWith(expect.objectContaining({ id: "note-cat", title: "夜猫", prompt: "夜色中的黑猫" }));
    act(() => tree.unmount());
  });

  it("requires a second click before deleting a note", () => {
    const deletePromptNote = vi.fn();
    const controllerValue = controller({
      promptNotes: notebookNotes,
      promptNotesReady: true,
      savePromptNote: vi.fn(),
      deletePromptNote,
      togglePromptNotePinned: vi.fn(),
      reorderPromptNote: vi.fn(),
    });
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<PromptNotebookPage controller={controllerValue} onClose={vi.fn()} />); });
    act(() => tree.root.findByProps({ "aria-label": "删除黑猫" }).props.onClick());
    expect(deletePromptNote).not.toHaveBeenCalled();
    const confirm = tree.root.findAll((node) => node.type === "button" && node.children.includes("确认"));
    expect(confirm).toHaveLength(1);
    act(() => confirm[0].props.onClick());
    expect(deletePromptNote).toHaveBeenCalledWith("note-cat");
    act(() => tree.unmount());
  });
  it("keeps balance in the header row and moves its update time into the tooltip", () => {
    const html = renderToStaticMarkup(<PanelHeader controller={controller({
      balance: {
        status: "available",
        unit: "积分",
        remaining: 1_490_000,
        total: 20_000_000,
        updatedAt: new Date(2026, 6, 27, 19, 37, 55).getTime(),
      },
      settings: {
        baseUrl: "https://async.xinbao-ai.com",
        apiKey: "",
        modelOptions: [],
        connectionStatus: "connected",
        providerSnapshot: null,
      },
      refreshBalance: vi.fn(),
      setSettingsOpen: vi.fn(),
    })} />);
    expect(html).toContain("149万 积分");
    expect(html).toContain("上次更新：");
    expect(html).toContain("balance-summary");
    expect(html).not.toContain("balance-status-row");
    expect(html).not.toContain("balance-popover");

    const css = readFileSync("src/styles.css", "utf8");
    expect(css).not.toMatch(/\.balance-status-row\s*\{/);
    expect(css).toMatch(/\.balance-summary\s*\{[^}]*max-width:\s*68px/s);
    expect(css).toMatch(/\.provider-meta\s*\{[^}]*display:\s*flex/s);
    expect(css).not.toMatch(/\.provider-meta\s*\{[^}]*display:\s*grid/s);
  });

  it("opens cloud records from the header and renders explicit error and empty states", () => {
    const setCloudRecordsOpen = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<PanelHeader controller={controller({ setCloudRecordsOpen })} />); });
    act(() => tree.root.findByProps({ "aria-label": "打开云端生图记录" }).props.onClick());
    expect(setCloudRecordsOpen).toHaveBeenCalledWith(true);
    act(() => tree.unmount());

    const idle = renderToStaticMarkup(<CloudRecordsPage controller={controller({
      cloudRecordsStatus: "idle",
      cloudRecordsError: null,
      cloudRecords: [],
      cloudTaskImages: {},
      refreshCloudTasks: vi.fn(),
      setCloudRecordsOpen,
      loadCloudTaskImage: vi.fn(),
    })} />);
    expect(idle).toContain("正在准备云端记录");

    const unauthorized = renderToStaticMarkup(<CloudRecordsPage controller={controller({
      cloudRecordsStatus: "error",
      cloudRecordsError: "云端记录鉴权失败（401）",
      cloudRecords: [],
      cloudTaskImages: {},
      refreshCloudTasks: vi.fn(),
      setCloudRecordsOpen,
      loadCloudTaskImage: vi.fn(),
    })} />);
    expect(unauthorized).toContain("云端记录鉴权失败（401）");
    expect(unauthorized).toContain(">重试</button>");

    const empty = renderToStaticMarkup(<CloudRecordsPage controller={controller({
      cloudRecordsStatus: "ready",
      cloudRecordsError: null,
      cloudRecords: [],
      cloudTaskImages: {},
      refreshCloudTasks: vi.fn(),
      setCloudRecordsOpen,
      loadCloudTaskImage: vi.fn(),
    })} />);
    expect(empty).toContain("最近 3 天没有云端生图记录");
  });

  it("automatically requests visible cloud thumbnails and exposes concrete retry errors", () => {
    const loadCloudTaskImage = vi.fn();
    const setCloudRecordsOpen = vi.fn();
    const refreshCloudTasks = vi.fn();
    const task = {
      taskId: "task-plugin-1",
      model: "gpt-image-2-oai",
      status: "succeeded",
      createdAt: Date.now(),
      completedAt: Date.now(),
      thumbnailUrl: "https://cdn.example/task.png",
      origin: "plugin" as const,
    };
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<CloudRecordsPage controller={controller({
      cloudRecordsStatus: "ready",
      cloudRecordsError: null,
      cloudRecords: [task],
      cloudTaskImages: {},
      refreshCloudTasks,
      setCloudRecordsOpen,
      loadCloudTaskImage,
    })} />); });
    expect(loadCloudTaskImage).toHaveBeenCalledWith(task);
    expect(tree.root.findAll((node) => node.type === "button" && node.children.includes("加载缩略图"))).toHaveLength(0);
    act(() => { tree.update(<CloudRecordsPage controller={controller({
      cloudRecordsStatus: "ready",
      cloudRecordsError: null,
      cloudRecords: [task],
      cloudTaskImages: { [task.taskId]: { status: "error", error: "图片下载失败（503）" } },
      refreshCloudTasks,
      setCloudRecordsOpen,
      loadCloudTaskImage,
    })} />); });
    expect(tree.root.findByProps({ className: "cloud-task__error" }).findAllByType("span").some((node) => node.children.includes("图片下载失败（503）"))).toBe(true);
    act(() => tree.root.findByProps({ "aria-label": "重试任务 task-plugin-1 图片" }).props.onClick());
    expect(loadCloudTaskImage).toHaveBeenCalledTimes(2);
    act(() => tree.root.findByProps({ "aria-label": "刷新云端生图记录" }).props.onClick());
    expect(refreshCloudTasks).toHaveBeenCalledOnce();
    act(() => tree.root.findByProps({ "aria-label": "返回生成界面" }).props.onClick());
    expect(setCloudRecordsOpen).toHaveBeenCalledWith(false);
    act(() => tree.unmount());
  });

  it("automatically requests detail recovery when a succeeded cloud record has no list thumbnail", () => {
    const loadCloudTaskImage = vi.fn();
    const task = {
      taskId: "task-detail-needed",
      model: "gpt-image-2-oai",
      status: "succeeded" as const,
      createdAt: null,
      completedAt: null,
      thumbnailUrl: null,
      origin: "plugin" as const,
    };
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<CloudRecordsPage controller={controller({
      cloudRecordsStatus: "ready",
      cloudRecordsError: null,
      cloudRecords: [task],
      cloudTaskImages: {},
      refreshCloudTasks: vi.fn(),
      setCloudRecordsOpen: vi.fn(),
      loadCloudTaskImage,
    })} />); });

    expect(loadCloudTaskImage).toHaveBeenCalledWith(task);
    expect(tree.root.findAll((node) => node.type === "button" && node.children.includes("加载缩略图"))).toHaveLength(0);
    expect(tree.root.findAll((node) => node.type === "small" && node.children.join("") === "创建 时间未知")).toHaveLength(1);
  });

  it("renders only twelve cloud cards before load-more reveals the next page", () => {
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
    act(() => { tree = create(<CloudRecordsPage controller={controller({
      cloudRecordsStatus: "ready",
      cloudRecordsError: null,
      cloudRecords: tasks,
      cloudTaskImages: {},
      refreshCloudTasks: vi.fn(),
      setCloudRecordsOpen: vi.fn(),
      loadCloudTaskImage,
    })} />); });
    expect(tree.root.findAllByType("article")).toHaveLength(12);
    expect(loadCloudTaskImage).toHaveBeenCalledTimes(12);
    act(() => tree.root.findByProps({ "aria-label": "加载更多云端记录" }).props.onClick());
    expect(tree.root.findAllByType("article")).toHaveLength(13);
    expect(loadCloudTaskImage).toHaveBeenCalledTimes(13);
  });

  it("uses explicit model wording and a compact integer balance", () => {
    const parameters = renderToStaticMarkup(<DetailParameters controller={controller({
      draft: { ...draft, model: "auto" },
      settings: {
        baseUrl: "https://async.xinbao-ai.com",
        apiKey: "",
        modelOptions: ["auto"],
        connectionStatus: "connected",
        providerSnapshot: null,
      },
    })} />);
    expect(parameters).toContain('aria-label="模型"');
    expect(parameters).toContain('class="uxp-dropdown__value">自动选择</span>');
    expect(parameters).not.toContain("<select");

    const header = renderToStaticMarkup(<PanelHeader controller={controller({
      balance: {
        status: "available",
        unit: "积分",
        remaining: 3_136.8,
        total: 20_000,
      },
    })} />);
    expect(header).toContain("3,137 积分");
    expect(header).not.toContain("3,136.8");
  });

  it("removes the redundant product mark and keeps narrow mode labels complete", () => {
    const header = renderToStaticMarkup(<PanelHeader controller={controller()} />);
    expect(header).not.toContain("panel-logo");
    expect(header).not.toContain("<strong>生成填充</strong>");
    expect(header).toContain("API 凭据正常");

    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.mode-tabs\s*\{[^}]*border:\s*0[^}]*background:\s*transparent/s);
    expect(css).toMatch(/\.mode-tab strong\s*\{[^}]*white-space:\s*nowrap/s);
    expect(css).toMatch(/\.panel-header \.icon-button\s*\{[^}]*margin-left:\s*auto/s);
    expect(css).toMatch(/body\.uxp-shell \.property-section\s*\{[^}]*padding:\s*[0-4]px[^}]*border:\s*0/s);
    expect(css).toMatch(/body\.uxp-shell \.panel-section \+ \.panel-section\s*\{[^}]*margin-top:\s*[0-4]px/s);
  });

  it("removes UXP host control margins and keeps panel geometry stable while resizing", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/button,\s*input,\s*textarea,\s*select\s*\{[^}]*margin:\s*0/s);
    expect(css).toMatch(/body\.uxp-shell \.panel-section,[\s\S]*body\.uxp-shell \.panel-action-bar\s*\{[^}]*margin:\s*0/s);
    expect(css).toMatch(/body\.uxp-shell \.dock-panel\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none[^}]*height:\s*100%/s);
    expect(css).toMatch(/body\.uxp-shell \.property-section\s*\{[^}]*padding:\s*4px 9px 4px/s);
  });

  it("paints every UXP viewport layer opaquely during live panel resize", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/body\.uxp-shell,\s*body\.uxp-shell #root,\s*body\.uxp-shell \.prototype-stage,\s*body\.uxp-shell \.dock-panel\s*\{[^}]*background-color:\s*var\(--panel\)/s);
    expect(css).toMatch(/body\.uxp-shell \.dock-panel\s*\{[^}]*box-shadow:\s*none/s);
  });

  it("keeps section headings visually above tabs and field labels", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.property-heading,[\s\S]*\.section-title\s*\{[^}]*font-size:\s*14px[^}]*font-weight:\s*700/s);
    expect(css).toMatch(/\.prompt-field > span\s*\{[^}]*font-size:\s*14px[^}]*font-weight:\s*700/s);
    expect(css).toMatch(/\.mode-tab strong\s*\{[^}]*font-size:\s*11px[^}]*font-weight:\s*600/s);
    expect(css).toMatch(/\.parameter-cell\s*\{[^}]*font-size:\s*11px/s);
  });

  it("centers compact parameter values and suppresses motion during UXP live resize", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const source = readFileSync("src/PluginPanel.tsx", "utf8");
    expect(css).toMatch(/\.parameter-cell > span\s*\{[^}]*text-align:\s*center/s);
    expect(css).toMatch(/\.field-row select,[\s\S]*\.count-stepper__value\s*\{[^}]*text-align:\s*center/s);
    expect(css).toMatch(/\.field-row select,[\s\S]*\.parameter-cell select\s*\{[^}]*text-align-last:\s*center/s);
    expect(css).toMatch(/\.field-row select option,[\s\S]*\.parameter-cell select option\s*\{[^}]*text-align:\s*center/s);
    expect(css).toMatch(/body\.uxp-shell \.plugin-panel\.is-resizing,[\s\S]*body\.uxp-shell \.plugin-panel\.is-resizing \*\s*\{[^}]*animation:\s*none !important[^}]*transition:\s*none !important/s);
    expect(source).toContain('window.addEventListener("resize", handleResize)');
    expect(source).toContain('classList.add("is-resizing")');
  });

  it("keeps the empty reference actions side by side in the narrow UXP panel", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const html = renderToStaticMarkup(<ReferenceImages controller={controller()} showHeading={false} />);
    expect(html).toContain('class="reference-empty-actions"');
    expect(html).toContain("本地图片");
    expect(html).toContain("当前选区");
    expect(css).toMatch(/\.reference-empty-actions\s*\{[^}]*display:\s*flex/s);
    expect(css).toMatch(/body\.uxp-shell \.reference-empty-action\s*\{[^}]*flex:\s*1 1 0/s);
  });

  it("gives UXP dropdown triggers and menus a stable centered control surface", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.uxp-dropdown__trigger\s*\{[^}]*display:\s*flex[^}]*height:\s*27px/s);
    expect(css).toMatch(/\.uxp-dropdown__trigger\[aria-expanded="true"\]/);
    expect(css).toMatch(/\.uxp-dropdown__list\s*\{[^}]*position:\s*absolute[^}]*z-index:\s*40/s);
  });

  it("uses real DOM dropdown buttons without native-select or fake-value layers", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const shared = readFileSync("src/components/Shared.tsx", "utf8");
    const dropdown = readFileSync("src/components/UxpDropdown.tsx", "utf8");
    expect(shared).toContain('className="field-row__label"');
    expect(dropdown).toContain('aria-haspopup="listbox"');
    expect(dropdown).toContain('role="option"');
    expect(dropdown).toContain("setOpenId(id)");
    expect(css).toMatch(/\.uxp-dropdown__value\s*\{[^}]*text-align:\s*center/s);
    expect(`${shared}\n${css}`).not.toContain("CenteredSelect");
    expect(`${shared}\n${css}`).not.toContain("centered-select");
    expect(dropdown).not.toContain("<select");
    expect(css).not.toMatch(/\.uxp-dropdown[^}]*appearance:\s*none/s);
    expect(css).not.toMatch(/\.uxp-dropdown[^}]*color:\s*transparent/s);
  });

  it("puts the single generation blocker inside a disabled button", () => {
    const html = renderToStaticMarkup(
      <GenerateAction controller={controller({ validationMessage: "请先填写提示词" })} />,
    );
    expect(html).toContain('class="generate-button"');
    expect(html).toContain("disabled");
    expect(html).toContain(">请先填写提示词</button>");
    expect(html).not.toContain("生成 3 张");
  });

  it("turns the generation action into an enabled count button when valid", () => {
    const html = renderToStaticMarkup(<GenerateAction controller={controller()} />);
    expect(html).toContain(">生成 3 张</button>");
    expect(html).not.toContain("disabled");
  });

  it("replaces generation with progress and cancellation while a job is active", () => {
    const html = renderToStaticMarkup(<GenerateAction controller={controller({
      status: "running",
      stage: "generating",
      progress: 42,
      elapsedSeconds: 7,
    })} />);
    expect(html).toContain("供应商生成中 · 42% · 00:07");
    expect(html).toContain(">取消</button>");
    expect(html).not.toContain('class="generate-button"');
  });

  it("renders only the compact plus upload entry and a multiple image input", () => {
    const html = renderToStaticMarkup(<ReferenceImages controller={controller()} />);
    expect(html).toContain('aria-label="添加参考图"');
    expect(html).toContain('title="添加本地图片"');
    expect(html).toContain('type="file"');
    expect(html).toContain("multiple");
    expect(html).toContain('accept="image/*"');
    expect(html).toContain("本地图片");
    expect(html).toContain("当前选区");
    expect(html).not.toContain("拖入、粘贴");
    expect(html).not.toContain("当前画面");
    expect(html).not.toContain(">本地<");
  });

  it("expands references only after images exist and caps the add action at nine", () => {
    const references = Array.from({ length: 9 }, (_, index) => ({
      id: `ref-${index}`,
      name: `${index}.png`,
      url: `blob:${index}`,
      order: index,
      file: new File(["image"], `${index}.png`, { type: "image/png" }),
    }));
    const one = renderToStaticMarkup(<ReferenceImages controller={controller({
      draft: { ...draft, references: references.slice(0, 1) },
    })} />);
    expect(one).toContain("参考图 1/9");
    expect(one).toContain('aria-label="删除参考图"');
    expect(one).not.toContain('aria-label="向前移动"');
    expect(one).not.toContain('aria-label="向后移动"');
    expect(one).not.toContain("参考图全局强度");
    expect(one).not.toContain("全局强度");

    const nine = renderToStaticMarkup(<ReferenceImages controller={controller({
      draft: { ...draft, references },
    })} />);
    expect(nine).toContain("参考图 9/9");
    expect(nine).toContain('title="参考图最多 9 张"');
    expect(nine).toMatch(/aria-label="添加参考图"[^>]*disabled/);

    const stateSource = readFileSync("src/usePrototypeState.ts", "utf8");
    expect(stateSource).toContain('notify("参考图最多 9 张", "warning")');
    expect(stateSource).not.toMatch(/const moveReference\s*=/);
  });

  it.each([
    ["请先填写提示词", "请先填写提示词"],
    ["请先创建选区", "请先创建选区"],
    ["正在读取选区…", "正在读取选区…"],
    ["", "生成 3 张"],
  ])("keeps the fixed action label explicit for %s", (validationMessage, expected) => {
    const html = renderToStaticMarkup(<GenerateAction controller={controller({ validationMessage })} />);
    expect(html).toContain(expected);
  });

  it("keeps the generation action outside the scroll container", () => {
    const source = readFileSync("src/PluginPanel.tsx", "utf8");
    expect(source).toMatch(/<\/div>\s*\{!notebookOpen[\s\S]*<footer className="panel-action-bar">/);
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.plugin-panel \.panel-scroll\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.panel-action-bar\s*\{[^}]*flex:\s*0 0 auto/s);
    expect(css).toMatch(/\.panel-action-bar\s*\{[^}]*display:\s*block[^}]*width:\s*100%/s);
    expect(css).toMatch(/body\.uxp-shell \.generate-wrap\s*\{[^}]*width:\s*100%/s);
  });

  it("renders critical UXP actions with real DOM icons instead of CSS pseudo-elements", () => {
    const shared = renderToStaticMarkup(
      <>
        <PanelHeader controller={controller({
          balance: { status: "idle", unit: "积分" },
          settings: {
            baseUrl: "https://async.xinbao-ai.com",
            apiKey: "",
            modelOptions: [],
            connectionStatus: "connected",
            providerSnapshot: null,
          },
          refreshBalance: vi.fn(),
          setSettingsOpen: vi.fn(),
        })} />
        <ReferenceImages controller={controller()} />
        <GlobalOverlays controller={controller({
          settingsOpen: true,
          runtimeMode: "uxp",
          settings: {
            baseUrl: "https://async.xinbao-ai.com",
            apiKey: "secret",
            modelOptions: [],
            connectionStatus: "connected",
            providerSnapshot: null,
          },
          credentialSaveStatus: "saved",
          theme: "graphite",
          setSettingsOpen: vi.fn(),
          setSettings: vi.fn(),
          saveApiKey: vi.fn(),
          refreshModels: vi.fn(),
          testConnection: vi.fn(),
          setTheme: vi.fn(),
        })} />
      </>,
    );
    expect(shared).toContain("<span");
    expect(shared).toContain('data-uxp-icon="settings"');
    expect(shared).toContain('data-uxp-icon="plus"');
    expect(shared).toContain('data-uxp-icon="refresh"');
    expect(shared).toContain('data-uxp-icon="close"');
    expect(shared).not.toContain("css-icon");
  });

  it("uses real DOM symbols because Photoshop UXP does not reliably decode icon images", () => {
    const sharedSource = readFileSync("src/components/Shared.tsx", "utf8");
    expect(sharedSource).not.toMatch(/assets\/icons\/[^"]+\.(svg|png)/);
    expect(sharedSource).toContain("<span");
    expect(sharedSource).toContain("data-uxp-icon={name}");
  });

  it("keeps exactly the two approved generation modes", () => {
    const updateDraft = vi.fn();
    const tree = create(<ModeTabs controller={controller({ updateDraft })} />);
    const tabs = tree.root.findAllByProps({ role: "tab" });
    expect(tabs).toHaveLength(2);
    expect(tabs.every((tab) => tab.type === "button")).toBe(true);
    expect(tabs[0].findByType("strong").children.join("")).toContain("文生图");
    expect(tabs[1].findByType("strong").children.join("")).toContain("图生图");
    expect(tabs.filter((tab) => tab.props["aria-selected"])).toHaveLength(1);
    act(() => tabs[1].props.onClick());
    expect(updateDraft).toHaveBeenLastCalledWith({ mode: "redraw", outputTarget: "current-document" });
    const html = renderToStaticMarkup(<ModeTabs controller={controller()} />);
    expect(html).toContain('<button type="button"');
    expect(html).not.toContain("整图重绘");
    expect(html.indexOf("文生图")).toBeLessThan(html.indexOf("图生图"));
    act(() => tree.unmount());
  });

  it("keeps narrow UXP custom controls wide enough for their values", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.field-row\s*>\s*\.uxp-dropdown\s*\{[^}]*flex:\s*1 1 auto[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.parameter-cell\s*>\s*\.uxp-dropdown\s*\{[^}]*width:\s*100%/s);
    expect(css).toMatch(/body\.uxp-shell \.field-row\s*>\s*\.field-row__label\s*\{[^}]*flex:\s*0 0 58px/s);
    expect(css).toMatch(/body\.uxp-shell \.field-row\s*>\s*\.uxp-dropdown\s*\{[^}]*flex:\s*1 1 auto[^}]*width:\s*100%/s);
    expect(css).not.toMatch(/body\.uxp-shell \.field-row\s*>\s*span\s*\{/);
    expect(css).toMatch(/\.reference-empty-actions\s*\{[^}]*display:\s*flex/s);
    expect(css).toMatch(/\.prompt-header-button\s*\{[^}]*height:\s*27px[^}]*border:\s*1px solid var\(--line\)/s);
    expect(css).toMatch(/\.prompt-header-button:disabled\s*\{[^}]*border-color:\s*var\(--line\)/s);
  });

  it("supports keyboard activation without generating", () => {
    const updateDraft = vi.fn();
    const tree = create(<ModeTabs controller={controller({ updateDraft })} />);
    const tab = tree.root.findAllByProps({ role: "tab" })[1];
    const preventDefault = vi.fn();
    act(() => tab.props.onKeyDown({ key: "Enter", preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(updateDraft).toHaveBeenCalledWith({ mode: "redraw", outputTarget: "current-document" });
    act(() => tree.unmount());
  });

  it("shows truthful model capability source, count, and fetched time", () => {
    const html = renderToStaticMarkup(<GlobalOverlays controller={controller({
      settingsOpen: true,
      settings: {
        baseUrl: "https://example.test",
        apiKey: "",
        modelOptions: ["model-a", "model-b"],
        connectionStatus: "connected",
        providerSnapshot: {
          models: [
            { id: "model-a", confirmedImage: true, resolutions: ["2K"], qualityOptions: [], aspectRatios: ["1:1"], defaultResolution: "2K" },
            { id: "model-b", confirmedImage: true, resolutions: ["2K"], qualityOptions: [], aspectRatios: ["1:1"], defaultResolution: "2K" },
          ],
          credentialVerified: true,
          source: "api",
          fetchedAt: Date.UTC(2026, 0, 2, 3, 4),
          stale: false,
        },
      },
    })} />);
    expect(html).toContain("2 个模型");
    expect(html).toContain("能力来源");
    expect(html).toContain("最近同步");
  });

  it("gives the main prompt field enough height for multi-line editing", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.prompt-field textarea\s*\{[^}]*min-height:\s*72px/s);
    expect(css).toMatch(/body\.uxp-shell \.prompt-field textarea\s*\{[^}]*height:\s*72px[^}]*min-height:\s*72px[^}]*max-height:\s*72px/s);
  });

  it("groups connection settings into three readable sections with one primary action", () => {
    const html = renderToStaticMarkup(<GlobalOverlays controller={controller({
      settingsOpen: true,
      credentialSaveStatus: "idle",
      theme: "graphite",
      setSettingsOpen: vi.fn(),
      setSettings: vi.fn(),
      saveApiKey: vi.fn(),
      refreshModels: vi.fn(),
      testConnection: vi.fn(),
      setTheme: vi.fn(),
    })} />);
    expect(html).toContain(">API 连接<");
    expect(html).toContain(">模型能力<");
    expect(html).toContain(">外观<");
    expect(html).toContain("当前：石墨灰");
    expect(html.match(/settings-action--primary/g)).toHaveLength(1);
    expect(html).toContain('class="settings-secondary-actions"');
    expect(html).toMatch(/settings-secondary-actions[\s\S]*刷新模型[\s\S]*aria-label="测试连接"/);
  });

  it("keeps every settings group reachable in a short UXP panel", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/body\.uxp-shell \.settings-drawer\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/body\.uxp-shell \.settings-body\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/body\.uxp-shell \.settings-group\s*\{[^}]*flex:\s*0 0 auto/s);
    expect(css).toMatch(/\.prototype-stage\.settings-is-open \.plugin-panel\s*\{[^}]*display:\s*none/s);
  });

  it("exposes remembered settings as a checkbox and a separate reset command", () => {
    const setRememberLastSettings = vi.fn();
    const restoreDefaultGenerationSettings = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<GlobalOverlays controller={controller({
      settingsOpen: true,
      rememberLastSettings: true,
      generationSettingsReady: true,
      setRememberLastSettings,
      restoreDefaultGenerationSettings,
      credentialSaveStatus: "idle",
      theme: "graphite",
      setSettingsOpen: vi.fn(),
      setSettings: vi.fn(),
      saveApiKey: vi.fn(),
      refreshModels: vi.fn(),
      testConnection: vi.fn(),
      setTheme: vi.fn(),
    })} />); });
    const toggle = tree.root.findByProps({ type: "checkbox" });
    expect(toggle.props.checked).toBe(true);
    act(() => toggle.props.onChange({ target: { checked: false } }));
    expect(setRememberLastSettings).toHaveBeenCalledWith(false);
    const reset = tree.root.findAllByType("button").find((button) => button.props.children === "恢复默认设置");
    expect(reset).toBeTruthy();
    act(() => reset!.props.onClick());
    expect(restoreDefaultGenerationSettings).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });

  it("keeps disabled generation gray and limits purple hover to enabled buttons", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const disabled = css.match(/\.generate-button:disabled\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(disabled).toMatch(/background:\s*#383a3e/);
    expect(disabled).not.toMatch(/gradient|accent/);
    expect(css).toContain(".generate-button:hover:not(:disabled)");
    expect(css).toContain("translateY(-1px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("routes browser local input through the reference pipeline without claiming unsupported UXP drop", () => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const addReferences = vi.fn();
    const file = new File(["image"], "drop.png", { type: "image/png" });
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ReferenceImages controller={controller({ addReferences })} />);
    });
    const input = tree.root.findByType("input");
    const inputEvent = { target: { files: [file], value: "selected" } };
    act(() => input.props.onChange(inputEvent));
    expect(addReferences.mock.calls).toEqual([[[file]]]);
    expect(inputEvent.target.value).toBe("");
    act(() => tree.unmount());
    vi.unstubAllGlobals();
  });

  it("uses the UXP picker for the plus button", () => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const pickReferenceFiles = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ReferenceImages controller={controller({
        runtimeMode: "uxp",
        pickReferenceFiles,
      })} />);
    });
    const addButton = tree.root.find((node) => node.props["aria-label"] === "添加参考图");
    act(() => addButton.props.onClick());
    expect(pickReferenceFiles).toHaveBeenCalledOnce();
    act(() => tree.unmount());
    vi.unstubAllGlobals();
  });

  it("adds the current Photoshop selection directly instead of relying on host clipboard paste", () => {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const addSelectionReference = vi.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ReferenceImages controller={controller({
        runtimeMode: "uxp",
        addSelectionReference,
      })} />);
    });
    act(() => tree.root.findByProps({ "aria-label": "添加当前选区" }).props.onClick());
    expect(addSelectionReference).toHaveBeenCalledOnce();
    const source = readFileSync("src/components/Shared.tsx", "utf8");
    expect(source).not.toContain('addEventListener("paste"');
    expect(source).not.toContain('addEventListener("drop"');
    act(() => tree.unmount());
    vi.unstubAllGlobals();
  });

  it("clears the current prompt and all current-session references independently", () => {
    const updateDraft = vi.fn();
    let promptTree!: ReturnType<typeof create>;
    act(() => {
      promptTree = create(<PromptField
        controller={controller({
          draft: { ...draft, prompt: "需要清空的提示词" },
          updateDraft,
        })}
        onOpenNotebook={vi.fn()}
      />);
    });
    const clearPrompt = promptTree.root.findByProps({ "aria-label": "清空提示词" });
    expect(clearPrompt.props.disabled).toBe(false);
    act(() => clearPrompt.props.onClick());
    expect(updateDraft).toHaveBeenCalledWith({ prompt: "" });

    const clearReferences = vi.fn();
    const reference = {
      id: "ref-clear",
      name: "clear.png",
      url: "blob:clear",
      order: 0,
      file: new File(["image"], "clear.png", { type: "image/png" }),
    };
    let referenceTree!: ReturnType<typeof create>;
    act(() => {
      referenceTree = create(<ReferenceImages controller={controller({
        draft: { ...draft, references: [reference] },
        clearReferences,
      })} />);
    });
    const clearReferenceButton = referenceTree.root.findByProps({ "aria-label": "清空参考图" });
    expect(clearReferenceButton.props.disabled).toBe(false);
    act(() => clearReferenceButton.props.onClick());
    expect(clearReferences).toHaveBeenCalledOnce();

    const emptyPrompt = renderToStaticMarkup(<PromptField controller={controller()} onOpenNotebook={vi.fn()} />);
    expect(emptyPrompt).toMatch(/aria-label="清空提示词"[^>]*disabled=""/);
    const source = readFileSync("src/components/Shared.tsx", "utf8");
    const css = readFileSync("src/styles.css", "utf8");
    expect(source.match(/prompt-header-button/g)).toHaveLength(2);
    expect(css).toMatch(/\.prompt-field > span\s*\{[^}]*justify-content:\s*flex-start[^}]*gap:\s*6px/s);
    expect(css).toMatch(/\.prompt-field > span > \.prompt-field__actions\s*\{[^}]*margin-left:\s*18px/s);
    expect(css).toMatch(/\.prompt-header-button\s*\{[^}]*flex:\s*0 0 80px[^}]*width:\s*80px[^}]*min-width:\s*80px[^}]*height:\s*27px/s);
    expect(css).toMatch(/\.compact-clear-button:hover:not\(:disabled\)[^{]*\{[^}]*transform:\s*translateY\(-1px\)[^}]*box-shadow:/s);
    expect(css).toMatch(/\.prompt-header-button:active:not\(:disabled\)\s*\{[^}]*transform:\s*translateY\(0\) scale\(\.96\)/s);
    act(() => promptTree.unmount());
    act(() => referenceTree.unmount());
  });

  it("makes reference deletion explicit and stops the thumbnail event from swallowing it", () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const removeReference = vi.fn();
    const reference = {
      id: "ref-delete",
      name: "delete.png",
      url: "blob:delete",
      order: 0,
      file: new File(["image"], "delete.png", { type: "image/png" }),
    };
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ReferenceImages controller={controller({
        draft: { ...draft, references: [reference] },
        removeReference,
      })} />);
    });
    const stopPropagation = vi.fn();
    act(() => tree.root.findByProps({ "aria-label": "删除参考图" }).props.onClick({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(removeReference).toHaveBeenCalledWith("ref-delete");
    act(() => tree.unmount());
    vi.unstubAllGlobals();
  });

  it("reorders reference thumbnails by direct mouse drag with no arrow buttons", () => {
    const reorderReference = vi.fn();
    const references = Array.from({ length: 3 }, (_, index) => ({
      id: `drag-${index}`,
      name: `${index}.png`,
      url: `blob:drag-${index}`,
      order: index,
      file: new File(["image"], `${index}.png`, { type: "image/png" }),
    }));
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ReferenceImages controller={controller({
        draft: { ...draft, references },
        reorderReference,
      })} />);
    });
    const items = tree.root.findAll((node) => (
      node.type === "div" && String(node.props.className).includes("reference-item")
    ));
    const children = [
      { getBoundingClientRect: () => ({ left: 0, top: 0, width: 56, height: 56 }) },
      { getBoundingClientRect: () => ({ left: 61, top: 0, width: 56, height: 56 }) },
      { getBoundingClientRect: () => ({ left: 122, top: 0, width: 56, height: 56 }) },
    ];
    const preventDefault = vi.fn();
    act(() => items[0].props.onMouseDown({
      button: 0,
      clientX: 28,
      clientY: 28,
      currentTarget: { parentElement: { children } },
      preventDefault,
    }));
    const list = tree.root.findByProps({ className: "reference-list" });
    act(() => list.props.onMouseMove({ clientX: 150, clientY: 28 }));
    expect(items[0].props.className).toContain("is-dragging");
    expect(items[0].props.style.transform).toBe("translate(122px, 0px) scale(.94)");
    act(() => tree.root.findByType("section").props.onMouseUp());
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(reorderReference).toHaveBeenCalledWith("drag-0", 2);
    const html = renderToStaticMarkup(<ReferenceImages controller={controller({
      draft: { ...draft, references },
    })} />);
    expect(html).not.toContain("向前移动");
    expect(html).not.toContain("向后移动");
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.reference-item\s*\{[^}]*transition:\s*transform/s);
    expect(css).toMatch(/\.reference-item\.is-dragging\s*\{[^}]*cursor:\s*grabbing/s);
    act(() => tree.unmount());
  });

  it("wraps references to the available width and reorders across rows", () => {
    const reorderReference = vi.fn();
    const references = Array.from({ length: 6 }, (_, index) => ({
      id: `wrap-${index}`,
      name: `${index}.png`,
      url: `blob:wrap-${index}`,
      order: index,
      file: new File(["image"], `${index}.png`, { type: "image/png" }),
    }));
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ReferenceImages controller={controller({
        draft: { ...draft, references },
        reorderReference,
      })} />);
    });
    const items = tree.root.findAll((node) => (
      node.type === "div" && String(node.props.className).includes("reference-item")
    ));
    const centers = [
      [28, 28], [89, 28], [150, 28], [211, 28],
      [28, 89], [89, 89],
    ];
    const children = centers.map(([x, y]) => ({
      getBoundingClientRect: () => ({ left: x - 28, top: y - 28, width: 56, height: 56 }),
    }));
    act(() => items[1].props.onMouseDown({
      button: 0,
      clientX: 89,
      clientY: 28,
      currentTarget: { parentElement: { children } },
      preventDefault: vi.fn(),
    }));
    const list = tree.root.findByProps({ className: "reference-list" });
    act(() => list.props.onMouseMove({ clientX: 89, clientY: 89 }));
    expect(items[1].props.style.transform).toBe("translate(0px, 61px) scale(.94)");
    expect(items[4].props.style.transform).toBe("translate(183px, -61px)");
    act(() => tree.root.findByType("section").props.onMouseUp());
    expect(reorderReference).toHaveBeenCalledWith("wrap-1", 5);
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.reference-list\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(css).not.toMatch(/\.reference-list\s*\{[^}]*overflow-x:\s*auto/s);
    act(() => tree.unmount());
  });

  it("uses a small refined delete control instead of a large black square", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const source = readFileSync("src/components/Shared.tsx", "utf8");
    expect(source).toContain('className="reference-remove-glyph"');
    expect(css).toMatch(/\.reference-item > \.reference-remove\s*\{[^}]*width:\s*14px[^}]*height:\s*14px[^}]*border-radius:\s*50%/s);
    expect(css).toMatch(/\.reference-remove-glyph::before[^}]*height:\s*1px[^}]*background:/s);
    expect(css).toMatch(/\.reference-remove:hover\s*\{[^}]*background:/s);
  });

  it("removes reference strength from source, state, and generated UXP UI", () => {
    for (const file of [
      "src/types.ts",
      "src/usePrototypeState.ts",
      "src/documentSessionState.ts",
      "src/components/Shared.tsx",
    ]) {
      expect(readFileSync(file, "utf8")).not.toContain("referenceStrength");
    }
  });
});
