import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { capabilitySourceLabel } from "../backend/providerCapabilities";
import type { PrototypeController } from "../usePrototypeState";
import { MODE_META, QUALITY_META, type GenerationMode, type ImageQuality, type PromptNote, type ThemeKey } from "../types";
import { UxpDropdown } from "./UxpDropdown";

const UXP_ICONS = {
  "arrow-down": "↓",
  "arrow-up": "↑",
  balance: "◎",
  check: "✓",
  close: "×",
  cloud: "☁",
  key: "◇",
  layers: "▤",
  lock: "▣",
  plus: "+",
  refresh: "↻",
  settings: "⚙",
  status: "●",
  stop: "■",
  theme: "◐",
  zoom: "⌕",
} as const;

function UxpIcon({ name, className = "" }: {
  name: keyof typeof UXP_ICONS;
  className?: string;
}) {
  return (
    <span
      className={`uxp-icon ${className}`.trim()}
      data-uxp-icon={name}
      aria-hidden="true"
    >
      {UXP_ICONS[name]}
    </span>
  );
}

export function PanelHeader({ controller }: { controller: PrototypeController }) {
  const apiState = controller.settings.connectionStatus;
  const balance = controller.balance;
  const compactPoints = (value?: number) => {
    if (value === undefined) return "—";
    if (Math.abs(value) >= 100_000_000) return `${Math.round(value / 100_000_000)}亿`;
    if (Math.abs(value) >= 10_000) return `${Math.round(value / 10_000)}万`;
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
  };
  const low = balance.status === "available"
    && !balance.unlimited
    && balance.remaining !== undefined
    && balance.total !== undefined
    && balance.total > 0
    && balance.remaining / balance.total <= 0.1;
  const empty = balance.status === "available" && balance.remaining !== undefined && balance.remaining <= 0;
  const labelText = balance.status === "loading"
      ? "查询中"
      : balance.status === "available"
      ? balance.unlimited ? "不限积分" : `${compactPoints(balance.remaining)} 积分`
      : balance.status === "unsupported" || balance.status === "error"
        ? "余额不可用"
        : "— 积分";
  const updatedAt = balance.updatedAt
    ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(balance.updatedAt)
    : "—";
  return (
    <>
      <header className="panel-header">
        <span className={`api-indicator api-indicator--${apiState}`} title="OpenAI 兼容 API 状态，以设置中的连接测试结果为准">
          <i />{apiState === "connected" ? "API 凭据正常" : apiState === "reachable" ? "API 服务可达" : apiState === "testing" ? "API 连接测试中" : apiState === "failed" ? "API 连接失败" : "API 未连接"}
        </span>
        <span className="balance-summary-wrap">
          <span
            className={`balance-summary ${low ? "is-low" : ""} ${empty ? "is-empty" : ""}`}
            role="button"
            tabIndex={0}
            title={balance.error ? `${balance.error}；点击重试` : `点击刷新积分余额；上次更新：${updatedAt}`}
            onClick={controller.refreshBalance}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                controller.refreshBalance();
              }
            }}
          >
            <UxpIcon name="balance" />{labelText}
          </span>
        </span>
        <span className="panel-header__actions">
          <button className="icon-button" type="button" aria-label="打开云端生图记录" onClick={() => controller.setCloudRecordsOpen(true)}>
            <UxpIcon name="cloud" />
          </button>
          <button className="icon-button" type="button" aria-label="打开设置" onClick={() => controller.setSettingsOpen(true)}>
            <UxpIcon name="settings" className="settings-glyph" />
          </button>
        </span>
      </header>
    </>
  );
}

function cloudTaskTime(value: number | null) {
  if (!value) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export function CloudRecordsPage({ controller }: { controller: PrototypeController }) {
  const [visibleCount, setVisibleCount] = useState(12);
  const requestedTaskIdsRef = useRef(new Set<string>());
  const visibleRecords = controller.cloudRecords.slice(0, visibleCount);
  const visibleTaskIds = visibleRecords.map((task) => task.taskId).join("|");
  useEffect(() => {
    if (controller.cloudRecordsStatus === "loading") {
      requestedTaskIdsRef.current.clear();
      setVisibleCount(12);
      return;
    }
    if (controller.cloudRecordsStatus !== "ready") return;
    visibleRecords.forEach((task) => {
      if (controller.cloudTaskImages[task.taskId] || requestedTaskIdsRef.current.has(task.taskId)) return;
      requestedTaskIdsRef.current.add(task.taskId);
      controller.loadCloudTaskImage(task);
    });
  }, [controller.cloudRecordsStatus, controller.cloudTaskImages, controller.loadCloudTaskImage, visibleTaskIds]);
  return (
    <section className="cloud-records-page">
      <header className="cloud-records__header">
        <span><strong>云端生图记录</strong><small>最近 3 天</small></span>
        <div>
          <button type="button" aria-label="刷新云端生图记录" onClick={controller.refreshCloudTasks} disabled={controller.cloudRecordsStatus === "loading"}>
            <UxpIcon name="refresh" className={controller.cloudRecordsStatus === "loading" ? "spin" : ""} />
          </button>
          <button type="button" aria-label="返回生成界面" onClick={() => controller.setCloudRecordsOpen(false)}>
            <UxpIcon name="close" />
          </button>
        </div>
      </header>
      {controller.cloudRecordsStatus === "idle" && <div className="cloud-records__state">正在准备云端记录…</div>}
      {controller.cloudRecordsStatus === "loading" && <div className="cloud-records__state">正在读取云端记录…</div>}
      {controller.cloudRecordsStatus === "error" && (
        <div className="cloud-records__state is-error">
          <span>{controller.cloudRecordsError}</span>
          <button type="button" onClick={controller.refreshCloudTasks}>重试</button>
        </div>
      )}
      {controller.cloudRecordsStatus === "ready" && controller.cloudRecords.length === 0 && (
        <div className="cloud-records__state">最近 3 天没有云端生图记录</div>
      )}
      <div className="cloud-records__list">
        {visibleRecords.map((task) => {
          const image = controller.cloudTaskImages[task.taskId];
          return (
            <article className="cloud-task" key={task.taskId}>
              <div className="cloud-task__preview">
                {image?.status === "ready" && image.url
                  ? <img src={image.url} alt="云端任务缩略图" />
                  : image?.status === "error"
                    ? <span className="cloud-task__error"><span>{image.error || "缩略图加载失败"}</span><button type="button" aria-label={`重试任务 ${task.taskId} 图片`} onClick={() => controller.loadCloudTaskImage(task)}>重试</button></span>
                    : <span>加载中…</span>}
              </div>
              <div className="cloud-task__meta">
                <div><strong>{task.model || "未知模型"}</strong><span className={`cloud-task__status is-${task.status}`}>{task.status}</span></div>
                <small>创建 {cloudTaskTime(task.createdAt)}</small>
                <small>完成 {cloudTaskTime(task.completedAt)}</small>
                <code title={task.taskId}>{task.taskId}</code>
                <small>{task.origin === "plugin" ? "本插件提交" : "其他来源或无法确认"}</small>
              </div>
            </article>
          );
        })}
      </div>
      {visibleCount < controller.cloudRecords.length && (
        <button className="cloud-records__more" type="button" aria-label="加载更多云端记录" onClick={() => setVisibleCount((count) => count + 12)}>加载更多</button>
      )}
    </section>
  );
}

export function PrototypeNotice({ controller }: { controller: PrototypeController }) {
  return <div className="prototype-notice">{controller.runtimeMode === "uxp" ? "OpenAI 兼容 API · Key 存入 UXP 安全存储 · Photoshop 真实写入" : "浏览器演示模式 · Key 仅驻留内存 · 不写入 Photoshop"}</div>;
}

export function ModeTabs({ controller, cards = false }: { controller: PrototypeController; cards?: boolean }) {
  const selectMode = (mode: GenerationMode) => controller.updateDraft({
    mode,
    ...(mode === "text" ? {} : { outputTarget: "current-document" as const }),
  });
  return (
    <div className={`mode-tabs ${cards ? "mode-tabs--cards" : ""}`} role="tablist" aria-label="生成方式">
      {(Object.keys(MODE_META) as GenerationMode[]).map((mode) => (
        <button
          key={mode}
          type="button"
          className={`mode-tab ${controller.draft.mode === mode ? "is-active" : ""}`}
          role="tab"
          aria-selected={controller.draft.mode === mode}
          onClick={() => selectMode(mode)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            selectMode(mode);
          }}
        >
          <strong>{MODE_META[mode].label}</strong>
          {cards && <small>{MODE_META[mode].description}</small>}
        </button>
      ))}
    </div>
  );
}

export function PromptField({ controller, prominent = false, dragHandle, onOpenNotebook }: { controller: PrototypeController; prominent?: boolean; dragHandle?: ReactNode; onOpenNotebook: () => void }) {
  const required = true;
  return (
    <div className={`prompt-field ${prominent ? "prompt-field--prominent" : ""}`}>
      <span>
        <span>{dragHandle}提示词 <small title={required ? "生成前必须填写提示词" : "可留空，按上下文填充"}>{required ? "必填" : "可选"}</small></span>
        <span className="prompt-field__actions">
          <button
            className="compact-clear-button prompt-clear-button prompt-header-button"
            type="button"
            aria-label="清空提示词"
            disabled={!controller.draft.prompt}
            onClick={() => controller.updateDraft({ prompt: "" })}
          >清空</button>
          <button className="prompt-notebook-trigger prompt-header-button" type="button" aria-expanded={false} onClick={onOpenNotebook}>提示词本</button>
        </span>
      </span>
      <textarea
        value={controller.draft.prompt}
        onChange={(event) => controller.updateDraft({ prompt: event.target.value })}
        placeholder={controller.draft.mode === "redraw" ? "描述希望如何重绘当前画面…" : required ? "描述希望生成的画面…" : "可选：描述选区中需要出现的内容…"}
      />
    </div>
  );
}

export function PromptNotebookPage({ controller, onClose }: { controller: PrototypeController; onClose: () => void }) {
  const [notebookView, setNotebookView] = useState<"favorites" | "history">("favorites");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PromptNote["mode"]>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorTitle, setEditorTitle] = useState("");
  const [editorPrompt, setEditorPrompt] = useState("");
  const [editorMode, setEditorMode] = useState<PromptNote["mode"]>("all");
  const [editorBaseline, setEditorBaseline] = useState({ title: "", prompt: "", mode: "all" as PromptNote["mode"] });
  const [editorError, setEditorError] = useState("");
  const [discardArmed, setDiscardArmed] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [clearHistoryArmed, setClearHistoryArmed] = useState(false);
  const notes = controller.promptNotes ?? [];
  const history = controller.promptHistory ?? [];
  const notesReady = controller.promptNotesReady !== false;
  const filteredNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return notes.filter((note) => {
      const matchesMode = filter === "all" || note.mode === "all" || note.mode === filter;
      const matchesQuery = !normalizedQuery
        || note.title.toLocaleLowerCase().includes(normalizedQuery)
        || note.prompt.toLocaleLowerCase().includes(normalizedQuery);
      return matchesMode && matchesQuery;
    });
  }, [filter, notes, query]);
  const filteredHistory = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return history.filter((entry) => (
      (filter === "all" || entry.mode === filter)
      && (!normalizedQuery || entry.prompt.toLocaleLowerCase().includes(normalizedQuery))
    ));
  }, [filter, history, query]);
  const editorDirty = editorTitle !== editorBaseline.title
    || editorPrompt !== editorBaseline.prompt
    || editorMode !== editorBaseline.mode;

  const resetEditor = () => {
    setEditingId(null);
    setEditorTitle("");
    setEditorPrompt("");
    setEditorMode("all");
    setEditorBaseline({ title: "", prompt: "", mode: "all" });
    setEditorError("");
    setDiscardArmed(false);
  };
  const requestClose = () => {
    if (editingId && editorDirty) {
      setDiscardArmed(true);
      return;
    }
    resetEditor();
    onClose();
  };
  const beginNew = (prefillCurrent = false) => {
    setEditingId("new");
    setEditorTitle("");
    setEditorPrompt(prefillCurrent ? controller.draft.prompt.trim() : "");
    setEditorMode(controller.draft.mode);
    setEditorBaseline({ title: "", prompt: prefillCurrent ? controller.draft.prompt.trim() : "", mode: controller.draft.mode });
    setEditorError("");
    setDiscardArmed(false);
  };
  const beginEdit = (note: PromptNote) => {
    setEditingId(note.id);
    setEditorTitle(note.title);
    setEditorPrompt(note.prompt);
    setEditorMode(note.mode);
    setEditorBaseline({ title: note.title, prompt: note.prompt, mode: note.mode });
    setEditorError("");
    setDiscardArmed(false);
  };
  const saveEditor = () => {
    const title = editorTitle.trim();
    const prompt = editorPrompt.trim();
    if (!title || !prompt) {
      setEditorError("标题和提示词不能为空");
      return;
    }
    const existing = editingId && editingId !== "new" ? notes.find((note) => note.id === editingId) : undefined;
    controller.savePromptNote({
      id: editingId && editingId !== "new" ? editingId : `note-${Date.now()}`,
      title,
      prompt,
      mode: editorMode,
      pinned: existing?.pinned ?? false,
      order: existing?.order,
    });
    resetEditor();
  };
  const useNote = (note: PromptNote) => {
    controller.updateDraft({ prompt: note.prompt });
    resetEditor();
    onClose();
  };
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [discardArmed, editorDirty, editingId]);

  return (
    <div className="prompt-notebook-page" role="dialog" aria-label="提示词本">
          <div className="prompt-notebook__header">
            <span><strong>提示词本</strong><small>{notebookView === "favorites" ? `${notes.length} 条收藏` : `${history.length} 条历史`}</small></span>
            <div>
              {notebookView === "favorites" && <button type="button" aria-label="新建提示词" title="新建提示词" onClick={() => beginNew()}><UxpIcon name="plus" /></button>}
              <button type="button" aria-label="返回主配置" title="返回" onClick={requestClose}>返回</button>
            </div>
          </div>
          <div className="prompt-notebook-tabs" role="tablist" aria-label="提示词本分类">
            <button type="button" role="tab" aria-selected={notebookView === "favorites"} onClick={() => setNotebookView("favorites")}>收藏</button>
            <button type="button" role="tab" aria-selected={notebookView === "history"} onClick={() => { resetEditor(); setNotebookView("history"); }}>历史</button>
          </div>
          {notebookView === "history" ? (
            <>
              <div className="prompt-notebook-toolbar">
                <input aria-label="搜索提示词历史" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索历史提示词" />
                <select aria-label="历史模式筛选" value={filter} onChange={(event) => setFilter(event.target.value as PromptNote["mode"])}>
                  <option value="all">全部</option>
                  {(Object.keys(MODE_META) as GenerationMode[]).map((mode) => <option key={mode} value={mode}>{MODE_META[mode].label}</option>)}
                </select>
              </div>
              <div className="prompt-notebook__list prompt-history-list">
                {controller.promptHistoryReady === false ? <small className="prompt-notebook-empty">正在读取提示词历史…</small> : filteredHistory.length === 0 ? <small className="prompt-notebook-empty">暂无生成成功的提示词历史</small> : filteredHistory.map((entry) => (
                  <article className="prompt-note-card" key={entry.id}>
                    <div className="prompt-note-card__main"><strong>{MODE_META[entry.mode].label}</strong><small>{entry.prompt}</small></div>
                    <span className="prompt-note-card__actions">
                      <button type="button" aria-label={`使用历史${entry.prompt}`} onClick={() => { controller.updateDraft({ prompt: entry.prompt }); onClose(); }}>使用</button>
                      <button type="button" aria-label={`删除历史${entry.prompt}`} onClick={() => controller.deletePromptHistory(entry.id)}><UxpIcon name="close" /></button>
                    </span>
                  </article>
                ))}
              </div>
              {history.length > 0 && (clearHistoryArmed
                ? <div className="prompt-history-clear-confirm"><span>清空全部提示词历史？</span><button type="button" className="is-danger" onClick={() => { controller.clearPromptHistory(); setClearHistoryArmed(false); }}>确认清空</button><button type="button" onClick={() => setClearHistoryArmed(false)}>取消</button></div>
                : <button type="button" className="prompt-history-clear" onClick={() => setClearHistoryArmed(true)}>清空历史</button>)}
            </>
          ) : editingId ? (
            <div className="prompt-notebook-editor">
              <input aria-label="提示词标题" value={editorTitle} onChange={(event) => setEditorTitle(event.target.value)} placeholder="给这条提示词命名" />
              <textarea aria-label="提示词正文" value={editorPrompt} onChange={(event) => setEditorPrompt(event.target.value)} placeholder="输入可复用的提示词…" />
              <div className="prompt-notebook-editor__row">
                <label><span>适用模式</span><select value={editorMode} onChange={(event) => setEditorMode(event.target.value as PromptNote["mode"])}>
                  <option value="all">全部模式</option>
                  {(Object.keys(MODE_META) as GenerationMode[]).map((mode) => <option key={mode} value={mode}>{MODE_META[mode].label}</option>)}
                </select></label>
                <button type="button" className="notebook-save" onClick={saveEditor}>保存</button>
              </div>
              {editorError && <small className="prompt-notebook-error">{editorError}</small>}
              {discardArmed && <div className="prompt-notebook-discard"><span>放弃未保存修改？</span><button type="button" onClick={() => { resetEditor(); onClose(); }}>放弃并返回</button><button type="button" onClick={() => setDiscardArmed(false)}>继续编辑</button></div>}
            </div>
          ) : (
            <>
              <div className="prompt-notebook-toolbar">
                <input aria-label="搜索提示词" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或正文" />
                <select aria-label="提示词模式筛选" value={filter} onChange={(event) => setFilter(event.target.value as PromptNote["mode"])}>
                  <option value="all">全部</option>
                  {(Object.keys(MODE_META) as GenerationMode[]).map((mode) => <option key={mode} value={mode}>{MODE_META[mode].label}</option>)}
                </select>
              </div>
              <div className="prompt-notebook__list">
                {!notesReady ? <small className="prompt-notebook-empty">正在读取提示词本…</small> : filteredNotes.length === 0 ? <small className="prompt-notebook-empty">没有匹配的提示词</small> : filteredNotes.map((note) => (
                  <article
                    className="prompt-note-card"
                    key={note.id}
                    draggable
                    onDragStart={() => setDraggingId(note.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (draggingId && draggingId !== note.id) controller.reorderPromptNote(draggingId, notes.findIndex((item) => item.id === note.id));
                      setDraggingId(null);
                    }}
                  >
                    <div className="prompt-note-card__main"><strong>{note.title}</strong><small>{note.prompt}</small></div>
                    <span className="prompt-note-card__actions">
                      <button type="button" aria-label={`使用${note.title}`} title="快速填入" onClick={() => useNote(note)}>使用</button>
                      <button type="button" aria-label={`${note.pinned ? "取消置顶" : "置顶"}${note.title}`} title={note.pinned ? "取消置顶" : "置顶"} onClick={() => controller.togglePromptNotePinned(note.id)}>{note.pinned ? "★" : "☆"}</button>
                      <button type="button" aria-label={`编辑${note.title}`} title="编辑" onClick={() => beginEdit(note)}>编辑</button>
                      {confirmDeleteId === note.id ? <><button type="button" className="is-danger" onClick={() => { controller.deletePromptNote(note.id); setConfirmDeleteId(null); }}>确认</button><button type="button" onClick={() => setConfirmDeleteId(null)}>取消</button></> : <button type="button" aria-label={`删除${note.title}`} title="删除" onClick={() => setConfirmDeleteId(note.id)}><UxpIcon name="close" /></button>}
                    </span>
                  </article>
                ))}
              </div>
              <button type="button" className="prompt-notebook-favorite" onClick={() => {
                const prompt = controller.draft.prompt.trim();
                if (!prompt) { beginNew(); setEditorError("当前没有可收藏的提示词"); return; }
                beginNew(true);
              }}><UxpIcon name="plus" />收藏当前提示词</button>
            </>
          )}
    </div>
  );
}

export function OutputControls({ controller, compact = false }: { controller: PrototypeController; compact?: boolean }) {
  const { draft } = controller;
  if (draft.mode !== "text") {
    return (
      <div className="locked-ratio">
        <span>输出比例</span>
        <strong>{controller.outputRatio}</strong>
        <small>自动跟随当前文档，作为命名图层写回</small>
      </div>
    );
  }
  const supportedRatios = controller.currentModelCapability?.aspectRatios ?? [];
  return (
    <div className={`output-controls ${compact ? "is-compact" : ""}`}>
      <div className="field-row">
        <span className="field-row__label">插入位置</span>
        <UxpDropdown id="output-target" ariaLabel="插入位置" value={draft.outputTarget} options={[
          { value: "new-document", label: "新建文档" },
          { value: "current-document", label: "当前文档新图层" },
        ]} onChange={(value) => controller.updateDraft({ outputTarget: value as "new-document" | "current-document" })} />
      </div>
      <div className="field-row">
        <span className="field-row__label">输出比例</span>
        <UxpDropdown
          id="aspect-ratio"
          ariaLabel="输出比例"
          value={draft.aspectRatio}
          options={[
            { value: "auto", label: "自动 · 跟随 API" },
            ...supportedRatios.map((ratio) => ({ value: ratio, label: ratio })),
            { value: "custom", label: "自定义比例" },
          ]}
          onChange={(value) => controller.updateDraft({ aspectRatio: value as typeof draft.aspectRatio })}
        />
      </div>
      {draft.aspectRatio === "custom" && (
        <div className="dimension-row" aria-label="自定义比例">
          <label><span>宽比</span><input aria-label="自定义比例宽" type="number" min="1" max="100" value={draft.customWidth} onChange={(event) => controller.setCustomDimension("customWidth", Number(event.target.value))} /></label>
          <span aria-hidden="true">:</span>
          <label><span>高比</span><input aria-label="自定义比例高" type="number" min="1" max="100" value={draft.customHeight} onChange={(event) => controller.setCustomDimension("customHeight", Number(event.target.value))} /></label>
        </div>
      )}
      <small className="ratio-note">{draft.aspectRatio === "auto" ? "比例以 API 模型返回的结果为准" : draft.aspectRatio === "custom" ? `自定义比例 ${controller.outputRatio}，生成结果保持该比例` : `生成结果保持 ${controller.outputRatio} 比例`}</small>
    </div>
  );
}

function CountStepper({ controller }: { controller: PrototypeController }) {
  const count = controller.draft.count;
  const setEnteredCount = (rawValue: string) => {
    if (!/^\d+$/.test(rawValue)) return;
    controller.setCount(Math.min(4, Math.max(1, Number(rawValue))));
  };
  return (
    <span className="count-stepper" role="group" aria-label="生成数量">
      <button type="button" aria-label="减少生成数量" disabled={count <= 1} onClick={() => { if (count > 1) controller.setCount(count - 1); }}>−</button>
      {controller.runtimeMode === "uxp" ? (
        <span className="count-stepper__value count-stepper__value--static" aria-live="polite">{count}</span>
      ) : (
        <input
          className="count-stepper__value"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          aria-label="直接输入生成数量"
          value={count}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setEnteredCount(event.currentTarget.value)}
          onBlur={(event) => { event.currentTarget.value = String(count); }}
        />
      )}
      <button type="button" aria-label="增加生成数量" disabled={count >= 4} onClick={() => { if (count < 4) controller.setCount(count + 1); }}>+</button>
    </span>
  );
}

export function DetailParameters({ controller, title = "详细参数", showHeading = true }: { controller: PrototypeController; title?: string; showHeading?: boolean }) {
  const { draft } = controller;
  const capability = controller.currentModelCapability;
  const resolutions = capability?.resolutions ?? ["api-default"];
  const qualities = capability?.qualityOptions ?? [];
  return (
    <section className="detail-parameters">
      {showHeading && <div className="section-title"><strong>{title}</strong><small>参数跟随当前模型能力</small></div>}
      <div className="parameter-grid">
        <label className="parameter-cell">
          <span>模型</span>
          <UxpDropdown id="model" ariaLabel="模型" value={draft.model} options={[
            ...(!draft.model ? [{ value: "", label: "请选择模型" }] : []),
            ...controller.settings.modelOptions.map((model) => ({ value: model, label: model === "auto" ? "自动选择" : model })),
          ]} onChange={(value) => controller.updateDraft({ model: value })} />
        </label>
        <label className="parameter-cell">
          <span>分辨率</span>
          <UxpDropdown id="resolution" ariaLabel="分辨率" value={draft.resolution} options={resolutions.map((resolution) => ({
            value: resolution,
            label: resolution === "api-default" ? "API 默认" : resolution,
          }))} onChange={(value) => controller.updateDraft({ resolution: value as typeof draft.resolution })} />
        </label>
        {qualities.length > 0 && (
          <label className="parameter-cell">
            <span>生成质量</span>
            <UxpDropdown id="quality" ariaLabel="生成质量" value={draft.quality} options={qualities.map((quality) => ({
              value: quality,
              label: `${QUALITY_META[quality].label} · ${QUALITY_META[quality].hint}`,
            }))} onChange={(value) => controller.updateDraft({ quality: value as ImageQuality })} />
          </label>
        )}
        <label className="parameter-cell parameter-cell--count">
          <span>生成数量</span>
          <CountStepper controller={controller} />
        </label>
      </div>
    </section>
  );
}

export function ReferenceImages({ controller, collapsed = false, showHeading = true }: { controller: PrototypeController; collapsed?: boolean; showHeading?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragState, setDragState] = useState<{
    id: string;
    from: number;
    to: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    slotCenters: Array<{ x: number; y: number }>;
  } | null>(null);
  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) controller.addReferences(event.target.files);
    event.target.value = "";
  };
  const pickLocal = () => controller.runtimeMode === "uxp"
    ? controller.pickReferenceFiles()
    : inputRef.current?.click();
  const finishReferenceDrag = () => {
    if (!dragState) return;
    if (dragState.from !== dragState.to) controller.reorderReference(dragState.id, dragState.to);
    setDragState(null);
  };
  const referenceTransform = (index: number, id: string) => {
    if (!dragState) return undefined;
    if (id === dragState.id) {
      return `translate(${dragState.currentX - dragState.startX}px, ${dragState.currentY - dragState.startY}px) scale(.94)`;
    }
    let targetSlot = index;
    if (dragState.from < dragState.to && index > dragState.from && index <= dragState.to) {
      targetSlot = index - 1;
    }
    if (dragState.from > dragState.to && index >= dragState.to && index < dragState.from) {
      targetSlot = index + 1;
    }
    if (targetSlot === index) return undefined;
    const from = dragState.slotCenters[index];
    const to = dragState.slotCenters[targetSlot];
    if (!from || !to) return undefined;
    return `translate(${to.x - from.x}px, ${to.y - from.y}px)`;
  };
  return (
    <section
      className={`references ${collapsed ? "references--compact" : ""}`}
      onMouseUp={finishReferenceDrag}
      onMouseLeave={finishReferenceDrag}
    >
      <input ref={inputRef} hidden type="file" multiple accept="image/*" onChange={handleFiles} />
      {controller.draft.references.length ? (
        <>
          <div className="references-actions">
            <span>参考图 {controller.draft.references.length}/9</span>
            <div className="references-actions__buttons">
              <button
                className="compact-clear-button reference-clear"
                type="button"
                aria-label="清空参考图"
                disabled={!controller.draft.references.length}
                onClick={controller.clearReferences}
              >清空</button>
              <button
                className="reference-selection-add"
                type="button"
                aria-label="添加当前选区"
                title="将 Photoshop 当前选区加入参考图"
                disabled={controller.draft.references.length >= 9 || controller.referenceCaptureStatus === "capturing"}
                onClick={controller.addSelectionReference}
              >选区</button>
              <button
                type="button"
                aria-label="添加参考图"
                title={controller.draft.references.length >= 9 ? "参考图最多 9 张" : "添加本地图片"}
                disabled={controller.draft.references.length >= 9}
                onClick={pickLocal}
              >
                <UxpIcon name="plus" className="reference-add-glyph" />
              </button>
            </div>
          </div>
          <div
            className="reference-list"
            onMouseMove={(event) => {
              const clientX = Number(event.clientX);
              const clientY = Number(event.clientY);
              if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
              setDragState((current) => {
                if (!current || !current.slotCenters.length) return current;
                const to = current.slotCenters.reduce((closest, center, candidate) => (
                  ((center.x - clientX) ** 2 + (center.y - clientY) ** 2)
                    < ((current.slotCenters[closest].x - clientX) ** 2 + (current.slotCenters[closest].y - clientY) ** 2)
                    ? candidate
                    : closest
                ), 0);
                if (to === current.to && clientX === current.currentX && clientY === current.currentY) return current;
                return { ...current, to, currentX: clientX, currentY: clientY };
              });
            }}
          >
            {controller.draft.references.map((image, index) => (
              <div
                className={`reference-item ${dragState?.id === image.id ? "is-dragging" : ""}`.trim()}
                key={image.id}
                style={{ transform: referenceTransform(index, image.id) }}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  const slotCenters = Array.from(event.currentTarget.parentElement?.children ?? [])
                    .map((element) => {
                      const bounds = (element as HTMLElement).getBoundingClientRect();
                      return {
                        x: bounds.left + bounds.width / 2,
                        y: bounds.top + bounds.height / 2,
                      };
                    })
                    .filter((center) => Number.isFinite(center.x) && Number.isFinite(center.y));
                  const startX = Number(event.clientX);
                  const startY = Number(event.clientY);
                  setDragState({
                    id: image.id,
                    from: index,
                    to: index,
                    startX: Number.isFinite(startX) ? startX : slotCenters[index]?.x ?? 0,
                    startY: Number.isFinite(startY) ? startY : slotCenters[index]?.y ?? 0,
                    currentX: Number.isFinite(startX) ? startX : slotCenters[index]?.x ?? 0,
                    currentY: Number.isFinite(startY) ? startY : slotCenters[index]?.y ?? 0,
                    slotCenters,
                  });
                }}
              >
                <img src={image.url} alt="" draggable={false} />
                <span>{index + 1}</span>
                <button
                  className="reference-remove"
                  aria-label="删除参考图"
                  title="删除参考图"
                  type="button"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    controller.removeReference(image.id);
                  }}
                ><span className="reference-remove-glyph" aria-hidden="true" /></button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="reference-empty-actions">
          <button className="reference-empty-action" type="button" aria-label="添加参考图" title="添加本地图片" onClick={pickLocal}>
            <UxpIcon name="plus" className="reference-add-glyph" />本地图片
          </button>
          <button
            className="reference-empty-action"
            type="button"
            aria-label="添加当前选区"
            title="将 Photoshop 当前选区加入参考图"
            disabled={controller.referenceCaptureStatus === "capturing"}
            onClick={controller.addSelectionReference}
          >{controller.referenceCaptureStatus === "capturing" ? "正在截取…" : "当前选区"}</button>
        </div>
      )}
    </section>
  );
}

export function GenerateAction({ controller, dragHandle }: { controller: PrototypeController; dragHandle?: ReactNode }) {
  const active = controller.status === "queued" || controller.status === "running";
  const stageLabel = {
    idle: "准备中",
    capturing: "正在截取 Photoshop 画面",
    uploading: "正在上传参考图",
    submitting: "正在提交任务",
    generating: "供应商生成中",
    downloading: "正在下载结果",
    completed: "已完成",
  }[controller.stage];
  const elapsed = `${Math.floor(controller.elapsedSeconds / 60).toString().padStart(2, "0")}:${(controller.elapsedSeconds % 60).toString().padStart(2, "0")}`;
  if (active) {
    return (
      <div className="generation-progress">
        <div>{dragHandle}<UxpIcon name="refresh" className="spin" /><span>{stageLabel} · {controller.progress}% · {elapsed}</span><button type="button" onClick={controller.cancelGeneration}><UxpIcon name="stop" />取消</button></div>
        <i><span style={{ transform: `scaleX(${Math.max(0, Math.min(100, controller.progress)) / 100})` }} /></i>
      </div>
    );
  }
  return (
    <div className="generate-wrap">
      <button className="generate-button" type="button" disabled={Boolean(controller.validationMessage)} onClick={controller.startGeneration}>
        {dragHandle}{controller.validationMessage || `生成 ${controller.draft.count} 张`}
      </button>
    </div>
  );
}

export function Results({ controller, dragHandle }: { controller: PrototypeController; dragHandle?: ReactNode }) {
  if (!controller.candidates.length) {
    return (
      <div className="results-empty">
        {dragHandle}<UxpIcon name="layers" /><strong>候选结果</strong><small>生成完成后在此选择并插入</small>
      </div>
    );
  }
  return (
    <section className="results">
      <div className="results-toolbar">
        <span>{dragHandle}<strong>{controller.candidates.length} 个候选</strong><small>{controller.outputRatio}</small></span>
        <div><button type="button" onClick={controller.returnToConfiguration}>返回修改</button></div>
      </div>
      <div className="preview-hint">
        {controller.previewStatus === "staging"
          ? "正在将候选放入 Photoshop 预览…"
          : controller.previewStatus === "switching"
            ? "正在切换预览…"
            : "点击候选图即可在 Photoshop 中实时预览"}
      </div>
      <div className="candidate-grid">
        {controller.candidates.map((candidate) => (
          <article key={candidate.id} className={candidate.selected ? "is-selected is-previewing" : ""}>
            <button className="candidate-select" type="button" aria-label={`选择${candidate.title}`} onClick={() => controller.toggleCandidate(candidate.id)}>
              {candidate.selected && <UxpIcon name="check" />}
            </button>
            <img src={candidate.url} alt={candidate.title} onClick={() => controller.activateCandidate(candidate.id)} />
            <button className="candidate-zoom" type="button" aria-label={`放大${candidate.title}`} onClick={() => controller.setPreviewCandidate(candidate)}>
              <UxpIcon name="zoom" />
            </button>
            <span>{candidate.title}</span>
          </article>
        ))}
      </div>
      <button className="insert-button" type="button" disabled={!controller.selectedCount || controller.previewStatus === "staging" || controller.previewStatus === "switching" || controller.previewStatus === "committing"} onClick={controller.insertSelected}>
        <UxpIcon name="check" />保留当前候选
      </button>
      <small className="non-destructive">其他候选仅作为临时预览，确认后会自动移除</small>
    </section>
  );
}

export function WriteRecovery({ controller }: { controller: PrototypeController }) {
  const candidate = controller.candidates[0];
  return (
    <section className="write-recovery" aria-label="图片写入恢复">
      <div className="write-recovery-heading">
        <UxpIcon name="status" />
        <span><strong>图片已生成，重试写入</strong><small>生成结果仍保留在当前文档会话中</small></span>
      </div>
      {candidate && <img src={candidate.url} alt="已生成但尚未写入的图片" />}
      {controller.writeError && <p role="alert">{controller.writeError}</p>}
      <div className="write-recovery-actions">
        <button type="button" disabled={controller.writeStatus === "writing"} onClick={controller.retryGeneratedWrite}>
          <UxpIcon name="refresh" />{controller.writeStatus === "writing" ? "正在写入…" : "重试写入"}
        </button>
        <button type="button" disabled={controller.writeStatus === "writing"} onClick={controller.discardGeneratedResult}>放弃结果</button>
      </div>
    </section>
  );
}

export function Disclosure({ title, summary, children, open = false, onToggle, dragHandle }: { title: string; summary?: string; children: ReactNode; open?: boolean; onToggle: () => void; dragHandle?: ReactNode }) {
  return (
    <div className={`disclosure ${open ? "is-open" : ""}`}>
      <button className="disclosure-summary" type="button" aria-expanded={open} onClick={onToggle}>
        <span>{dragHandle}<strong>{title}</strong>{summary && <small>{summary}</small>}</span>
        <b className="disclosure-toggle" aria-hidden="true">{open ? "−" : "+"}</b>
      </button>
      <div className="disclosure-content" hidden={!open} aria-hidden={!open}>{children}</div>
    </div>
  );
}

const THEME_OPTIONS: Array<{ key: ThemeKey; label: string; description: string }> = [
  { key: "graphite", label: "石墨灰", description: "Photoshop 风格" },
  { key: "midnight", label: "午夜蓝", description: "冷色高沉浸" },
  { key: "sakura", label: "樱花粉", description: "柔和轻盈" },
  { key: "forest", label: "森林绿", description: "自然沉静" },
  { key: "aurora", label: "极光紫", description: "梦幻渐变" },
  { key: "sunset", label: "珊瑚橙", description: "温暖明亮" },
];

function ThemePicker({ controller }: { controller: PrototypeController }) {
  const currentTheme = THEME_OPTIONS.find((theme) => theme.key === controller.theme) ?? THEME_OPTIONS[0];
  return (
    <section className="settings-group appearance-settings">
      <div className="settings-group__heading"><span><UxpIcon name="theme" />外观</span><small>当前：{currentTheme.label}</small></div>
      <div className="theme-grid">
        {THEME_OPTIONS.map((theme) => (
          <button type="button" key={theme.key} aria-label={theme.label} data-description={`${theme.label} · ${theme.description}`} className={`theme-option theme-option--${theme.key} ${controller.theme === theme.key ? "is-active" : ""}`} onClick={() => controller.setTheme(theme.key)}>
            {controller.theme === theme.key && <UxpIcon name="check" className="theme-check" />}
          </button>
        ))}
      </div>
    </section>
  );
}

export function GlobalOverlays({ controller }: { controller: PrototypeController }) {
  return (
    <>
      {controller.settingsOpen && (
        <div className="overlay" onMouseDown={() => controller.setSettingsOpen(false)}>
          <aside className="settings-drawer" onMouseDown={(event) => event.stopPropagation()}>
            <header><span><UxpIcon name="settings" />连接设置</span><button type="button" aria-label="关闭设置" onClick={() => controller.setSettingsOpen(false)}><UxpIcon name="close" className="settings-close-glyph" /></button></header>
            <PrototypeNotice controller={controller} />
            <div className="settings-body">
              <section className="settings-group api-connection-settings">
                <div className="settings-group__heading"><span><UxpIcon name="key" />API 连接</span><small>心宝及兼容服务</small></div>
                <label><span>Base URL</span><input value={controller.settings.baseUrl} onChange={(event) => controller.setSettings({ ...controller.settings, baseUrl: event.target.value, connectionStatus: "idle" })} /></label>
                <label><span>API Key</span><input type="password" autoComplete="off" placeholder={controller.runtimeMode === "uxp" ? "保存到 UXP 安全存储" : "仅保存在当前页面内存"} value={controller.settings.apiKey} onChange={(event) => controller.setSettings({ ...controller.settings, apiKey: event.target.value, connectionStatus: "idle" })} /><small>{controller.runtimeMode === "uxp" ? "由 Photoshop UXP 安全存储保存，仅发送到当前 Base URL。" : "仅驻留当前页面内存。"}</small></label>
                <button className={`settings-action settings-action--primary ${controller.credentialSaveStatus === "saved" ? "is-connected" : ""}`} type="button" onClick={controller.saveApiKey} disabled={controller.credentialSaveStatus === "saving"}>
                  <UxpIcon name={controller.credentialSaveStatus === "saving" ? "refresh" : "lock"} className={controller.credentialSaveStatus === "saving" ? "spin" : ""} />
                  {controller.credentialSaveStatus === "saving" ? "正在保存…" : controller.credentialSaveStatus === "saved" && controller.runtimeMode === "uxp" ? "已保存至 UXP 安全存储" : "保存 API 设置"}
                </button>
                <div className="settings-secondary-actions">
                  <button className="settings-action" type="button" onClick={controller.refreshModels}><UxpIcon name="refresh" />刷新模型</button>
                  <button className={`settings-action ${controller.settings.connectionStatus === "connected" ? "is-connected" : ""}`} type="button" aria-label="测试连接" onClick={controller.testConnection}>
                    <UxpIcon name={controller.settings.connectionStatus === "testing" ? "refresh" : "status"} className={controller.settings.connectionStatus === "testing" ? "spin" : "status-icon"} />
                    {controller.settings.connectionStatus === "testing" ? "测试中…" : controller.settings.connectionStatus === "connected" ? "凭据正常" : controller.settings.connectionStatus === "reachable" ? "服务可达" : controller.settings.connectionStatus === "failed" ? "重新测试" : "测试连接"}
                  </button>
                </div>
              </section>

              <section className="settings-group model-capability-settings">
                <div className="settings-group__heading"><span>模型能力</span><small>{controller.settings.providerSnapshot ? `${controller.settings.providerSnapshot.models.length} 个模型` : "尚未同步"}</small></div>
                <div className={`provider-meta ${controller.settings.providerSnapshot?.stale ? "is-stale" : ""}`}>
                  <span>能力来源</span><strong>{capabilitySourceLabel(controller.settings.providerSnapshot)}</strong>
                  {controller.settings.providerSnapshot && <small>最近同步：{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(controller.settings.providerSnapshot.fetchedAt)}</small>}
                </div>
                <div className="generation-memory-settings">
                  <label className="settings-toggle">
                    <span><strong>记忆最后设置</strong><small>两种模式分别保存</small></span>
                    <input type="checkbox" checked={controller.rememberLastSettings} disabled={!controller.generationSettingsReady} onChange={(event) => controller.setRememberLastSettings(event.target.checked)} />
                  </label>
                  <button className="settings-action settings-action--compact" type="button" onClick={controller.restoreDefaultGenerationSettings}>恢复默认设置</button>
                </div>
              </section>

              <ThemePicker controller={controller} />
            </div>
          </aside>
        </div>
      )}
      {controller.previewCandidate && (
        <div className="overlay preview-overlay" onMouseDown={() => controller.setPreviewCandidate(null)}>
          <section className="preview-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header><span><UxpIcon name="zoom" />{controller.previewCandidate.title}</span><button type="button" aria-label="关闭预览" onClick={() => controller.setPreviewCandidate(null)}><UxpIcon name="close" className="settings-close-glyph" /></button></header>
            <img src={controller.previewCandidate.url} alt={controller.previewCandidate.title} />
          </section>
        </div>
      )}
      {controller.toast && <div className={`toast toast--${controller.toast.kind}`}>{controller.toast.kind === "success" && <UxpIcon name="check" />}{controller.toast.text}</div>}
    </>
  );
}
