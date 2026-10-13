import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import { modelDisplayName } from "../backend/providerCapabilities";
import { pointsPerImage } from "../backend/pointPricing";
import type { PrototypeController } from "../usePrototypeState";
import { MODE_META, QUALITY_META, type GenerationMode, type ImageQuality, type PromptNote, type ThemeKey } from "../types";
import { UxpDropdown } from "./UxpDropdown";
import { CloudImage } from "./CloudImage";

const UXP_ICONS = {
  "arrow-down": "↓",
  "arrow-up": "↑",
  balance: "◎",
  check: "✓",
  close: "×",
  cloud: "☁",
  edit: "✎",
  key: "◇",
  layers: "▤",
  lock: "▣",
  plus: "+",
  refresh: "↻",
  settings: "⚙",
  star: "★",
  "star-outline": "☆",
  status: "●",
  stop: "■",
  theme: "◐",
  undo: "↶",
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

function connectionLabel(controller: PrototypeController) {
  if (!controller.settings.apiKey.trim()) return "未填 Key";
  const state = controller.settings.connectionStatus;
  if (state === "connected" || state === "reachable") return "已连接";
  if (state === "testing") return "检测中";
  if (state === "failed") return "连接失败";
  return "未连接";
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
        ? "余额查不到"
        : "— 积分";
  const updatedAt = balance.updatedAt
    ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(balance.updatedAt)
    : "—";
  return (
    <header className="panel-header">
      <span className={`api-indicator api-indicator--${apiState}`} title="和心宝的连接状态，可在设置里重新检测">
        <i />{connectionLabel(controller)}
      </span>
      <span
        className={`balance-summary ${low ? "is-low" : ""} ${empty ? "is-empty" : ""}`}
        role="button"
        tabIndex={0}
        title={balance.error ? `${balance.error}；点一下重试` : `点一下刷新余额；上次更新 ${updatedAt}`}
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
      <span className="panel-header__actions">
        <button className="icon-button" type="button" title="云端记录" aria-label="打开云端生图记录" onClick={() => controller.setCloudRecordsOpen(true)}>
          <UxpIcon name="cloud" />
        </button>
        <button className="icon-button" type="button" title="设置" aria-label="打开设置" onClick={() => controller.setSettingsOpen(true)}>
          <UxpIcon name="settings" className="settings-glyph" />
        </button>
      </span>
    </header>
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
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const library = controller.cloudLibrary;
  const group = (value: string) => ["succeeded", "completed", "success"].includes(value.toLowerCase()) ? "success"
    : ["failed", "error", "cancelled", "canceled"].includes(value.toLowerCase()) ? "failed" : "pending";
  const statusLabel = (value: string) => ({ succeeded: "已完成", completed: "已完成", success: "已完成", failed: "失败", error: "失败", cancelled: "已取消", canceled: "已取消", running: "生成中", processing: "生成中", queued: "排队中", pending: "排队中", uncertain: "结果不确定" }[value.toLowerCase()] ?? "状态待确认");
  const requestedTaskIdsRef = useRef(new Set<string>());
  // Keep the page useful even when an older UXP host has not populated the
  // newly-added controller fields yet. A blank page hides the real failure.
  const status = controller.cloudRecordsStatus ?? "loading";
  const records = Array.isArray(controller.cloudRecords) ? controller.cloudRecords : [];
  const images = controller.cloudTaskImages ?? {};
  const filtered = records.filter((task) => (filter === "all" || group(task.status) === filter)
    && `${task.model} ${modelDisplayName(task.model)} ${task.taskId} ${task.prompt ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const actualPage = Math.min(page, pages - 1);
  const visibleRecords = filtered.slice(actualPage * 12, (actualPage + 1) * 12);
  const visibleTaskIds = visibleRecords.map((task) => task.taskId).join("|");
  const missingKey = !controller.settings.apiKey.trim();
  useEffect(() => {
    requestedTaskIdsRef.current.clear();
    controller.clearCloudImages?.();
  }, [visibleTaskIds]);
  useEffect(() => {
    if (status === "loading") {
      requestedTaskIdsRef.current.clear();
      return;
    }
    if (status !== "ready") return;
    visibleRecords.forEach((task) => {
      if (images[task.taskId] || requestedTaskIdsRef.current.has(task.taskId)) return;
      requestedTaskIdsRef.current.add(task.taskId);
      controller.loadCloudTaskImage(task);
    });
  }, [status, images, controller.loadCloudTaskImage, visibleTaskIds]);
  const knownStatus = status === "idle" || status === "loading" || status === "ready" || status === "error";
  return (
    <section className="cloud-records-page" data-cloud-records-status={status}>
      <header className="page-header">
        <span><strong>{library?.task ? "云端原图" : "云端记录"}</strong><small>{library?.task ? "已生成的结果" : `最近 3 天 · ${records.length} 个任务`}</small></span>
        <div>
          <button type="button" title="刷新" aria-label="刷新云端生图记录" onClick={controller.refreshCloudTasks} disabled={status === "loading" || library?.busy}>
            <UxpIcon name="refresh" className={status === "loading" ? "spin" : ""} />
          </button>
          <button type="button" title={library?.task ? "返回列表" : "返回"} aria-label={library?.task ? "返回云端列表" : "返回生成界面"} disabled={library?.writing} onClick={() => { if (library?.task) library.close(); else controller.setCloudRecordsOpen(false); }}>
            <UxpIcon name="close" />
          </button>
        </div>
      </header>
      {library?.task ? <>
        <div className={`cloud-detail__preview${expanded ? " is-expanded" : ""}`}>
          {library.url ? <button type="button" title={expanded ? "缩小预览" : "放大预览"} onClick={() => setExpanded(!expanded)}><CloudImage key={library.url} src={library.url} alt={`生成结果 ${library.index + 1}`} /></button>
            : <span>{library.phase === "downloading" ? "正在取回原图…" : "原图还没取回"}</span>}
        </div>
        {(library.task.resultUrls?.length ?? 1) > 1 && <div className="cloud-detail__pager">
          <button type="button" aria-label="上一张结果" title="上一张" disabled={library.busy || library.index === 0} onClick={() => library.select(library.task!, library.index - 1)}>‹</button>
          <span>{library.index + 1} / {library.task.resultUrls?.length || 1}</span>
          <button type="button" aria-label="下一张结果" title="下一张" disabled={library.busy || library.index + 1 >= (library.task.resultUrls?.length || 1)} onClick={() => library.select(library.task!, library.index + 1)}>›</button>
        </div>}
        <div className="cloud-detail__info">
          <strong>{modelDisplayName(library.task.model)}</strong>
          <small>{cloudTaskTime(library.task.createdAt)}</small>
          {library.task.prompt && <p>{library.task.prompt}</p>}
          <code title="任务编号，找心宝站长核对时用">{library.task.taskId}</code>
        </div>
        {library.message && <div className={`cloud-detail__message is-${library.phase}`} role={library.phase === "error" ? "alert" : "status"}>{library.message}</div>}
        {library.phase === "downloading" && <button className="cloud-detail__secondary" type="button" onClick={library.close}>取消取回</button>}
        {!library.hasAsset && library.phase === "error" && <button className="cloud-detail__secondary" type="button" onClick={() => library.select(library.task!, library.index)}>重新取回原图</button>}
        <div className="cloud-detail__actions">
          <button type="button" className="cloud-detail__primary" disabled={!library.hasAsset || library.busy} onClick={() => library.transfer("current-document")}><UxpIcon name="layers" />放进当前文档</button>
          <button type="button" disabled={!library.hasAsset || library.busy} onClick={() => library.transfer("new-document")}><UxpIcon name="plus" />打开为新文档</button>
          <button type="button" disabled={!library.hasAsset || library.busy} onClick={() => library.transfer("save")}><UxpIcon name="arrow-down" />保存到电脑</button>
        </div>
      </> : <>
      <input className="cloud-records__search" type="text" aria-label="搜索云端记录" placeholder="搜索提示词或模型" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
      <div className="tab-strip" role="tablist" aria-label="任务状态">
        {[["all", "全部"], ["success", "已完成"], ["pending", "进行中"], ["failed", "失败"]].map(([value, label]) => <button key={value} role="tab" aria-selected={filter === value} type="button" onClick={() => { setFilter(value); setPage(0); }}>{label}</button>)}
      </div>
      {status === "idle" && <div className="cloud-records__state" aria-live="polite">正在准备云端记录…</div>}
      {status === "loading" && <div className="cloud-records__state" aria-live="polite">正在读取云端记录…</div>}
      {status === "error" && (
        <div className="cloud-records__state is-error">
          <span>{controller.cloudRecordsError || "云端记录读取失败"}</span>
          {missingKey
            ? <button type="button" onClick={() => { controller.setCloudRecordsOpen(false); controller.setSettingsOpen(true); }}>去设置</button>
            : <button type="button" onClick={controller.refreshCloudTasks}>重试</button>}
        </div>
      )}
      {status === "ready" && records.length === 0 && (
        <div className="cloud-records__state">最近 3 天没有生成记录</div>
      )}
      {!knownStatus && <div className="cloud-records__state" aria-live="polite">正在读取云端记录…</div>}
      {status === "ready" && records.length > 0 && !filtered.length && <div className="cloud-records__state">没有符合条件的记录</div>}
      <div className="cloud-records__list">
        {visibleRecords.map((task) => {
          const image = images[task.taskId];
          return (
            <article className="cloud-task" key={task.taskId} title={`任务编号 ${task.taskId}`}>
              <div className="cloud-task__preview">
                {image?.status === "ready" && image.url
                  ? <button type="button" title="查看原图" aria-label={`查看任务 ${task.taskId} 原图`} onClick={() => library?.select(task)}><CloudImage key={image.url} src={image.url} alt="云端任务缩略图" /></button>
                  : image?.status === "error"
                    ? <span className="cloud-task__error"><span>{image.error || "缩略图加载失败"}</span><button type="button" aria-label={`重试任务 ${task.taskId} 图片`} onClick={() => controller.loadCloudTaskImage(task)}>重试</button></span>
                    : <span>{group(task.status) === "success" ? "加载中…" : statusLabel(task.status)}</span>}
              </div>
              <div className="cloud-task__meta">
                <div><strong>{modelDisplayName(task.model) || "未知模型"}</strong><span className={`cloud-task__status is-${task.status}`}>{statusLabel(task.status)}</span></div>
                <small>{cloudTaskTime(task.createdAt)}{task.resultUrls?.length ? ` · ${task.resultUrls.length} 张` : ""}</small>
                {task.prompt ? <p className="cloud-task__prompt">{task.prompt}</p> : <small>{task.origin === "plugin" ? "本插件生成" : "其他地方生成"}</small>}
                {group(task.status) === "success" && <button className="cloud-task__retrieve" type="button" onClick={() => library?.select(task)}>取回原图 <UxpIcon name="arrow-down" /></button>}
              </div>
            </article>
          );
        })}
      </div>
      {pages > 1 && <nav className="cloud-detail__pager" aria-label="历史分页"><button type="button" title="上一页" disabled={actualPage === 0} onClick={() => setPage(actualPage - 1)}>‹</button><span>{actualPage + 1} / {pages}</span><button type="button" title="下一页" disabled={actualPage + 1 >= pages} onClick={() => setPage(actualPage + 1)}>›</button></nav>}
      </>}
    </section>
  );
}

export function ModeTabs({ controller }: { controller: PrototypeController }) {
  const selectMode = (mode: GenerationMode) => controller.updateDraft({
    mode,
    ...(mode === "text" ? {} : { outputTarget: "current-document" as const }),
  });
  return (
    <div className="mode-tabs" role="tablist" aria-label="生成方式">
      {(Object.keys(MODE_META) as GenerationMode[]).map((mode) => (
        <button
          key={mode}
          type="button"
          className={`mode-tab ${controller.draft.mode === mode ? "is-active" : ""}`}
          role="tab"
          aria-selected={controller.draft.mode === mode}
          title={MODE_META[mode].description}
          onClick={() => selectMode(mode)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            selectMode(mode);
          }}
        >
          <strong>{MODE_META[mode].label}</strong>
        </button>
      ))}
    </div>
  );
}

const SHORTCUT_LIMIT = 6;
const RECENT_LIMIT = 20;

/**
 * Prompt box with its saved prompts right underneath: favorites are one click
 * away as chips, everything else (all favorites, recent prompts) opens inline.
 */
export function PromptField({ controller }: { controller: PrototypeController }) {
  const prompt = controller.draft.prompt;
  const current = prompt.trim();
  const notes = controller.promptNotes ?? [];
  const history = controller.promptHistory ?? [];
  const favorite = current ? notes.find((note) => note.prompt === current) : undefined;
  const [libraryOpen, setLibraryOpen] = useState(false);
  // Filling or clearing the box can throw away typed text; one click brings it back.
  const [undoPrompt, setUndoPrompt] = useState<string | null>(null);
  const replace = (apply: () => void) => {
    setUndoPrompt(prompt.trim() ? prompt : null);
    apply();
  };
  const recent = history.filter((entry) => !notes.some((note) => note.prompt === entry.prompt));
  const hasLibrary = notes.length > 0 || recent.length > 0;
  return (
    <div className="prompt-field">
      <div className="prompt-field__header">
        <strong>提示词</strong>
        {undoPrompt !== null && (
          <button className="text-button text-button--accent" type="button" onClick={() => { controller.updateDraft({ prompt: undoPrompt }); setUndoPrompt(null); }}>
            <UxpIcon name="undo" />撤销
          </button>
        )}
        <span className="prompt-field__actions">
          <button
            className={`text-button ${favorite ? "is-on" : ""}`}
            type="button"
            aria-pressed={Boolean(favorite)}
            title={favorite ? "取消收藏这条提示词" : "收藏这条提示词，下次一点就能用"}
            disabled={!current}
            onClick={() => favorite ? controller.deletePromptNote(favorite.id) : controller.favoritePrompt(current)}
          >
            <UxpIcon name={favorite ? "star" : "star-outline"} />{favorite ? "已收藏" : "收藏"}
          </button>
          <button className="text-button" type="button" aria-label="清空提示词" disabled={!prompt} onClick={() => replace(() => controller.updateDraft({ prompt: "" }))}>清空</button>
        </span>
      </div>
      <textarea
        value={prompt}
        aria-label="提示词"
        onChange={(event) => { setUndoPrompt(null); controller.updateDraft({ prompt: event.target.value }); }}
        placeholder={controller.draft.mode === "redraw" ? "想把当前画面改成什么样…" : "描述想要的画面…"}
      />
      <div className="prompt-shortcuts">
        {notes.slice(0, SHORTCUT_LIMIT).map((note) => (
          <button
            key={note.id}
            className={`prompt-chip ${note.prompt === current ? "is-current" : ""}`}
            type="button"
            title={note.prompt}
            onClick={() => replace(() => controller.applyPromptNote(note.id))}
          >{note.title}</button>
        ))}
        {!notes.length && <span className="prompt-shortcuts__hint">写好后点「☆ 收藏」，以后在这里一点就能用</span>}
        {hasLibrary && (
          <button className="prompt-chip prompt-chip--more" type="button" aria-expanded={libraryOpen} onClick={() => setLibraryOpen(!libraryOpen)}>
            {libraryOpen ? "收起" : notes.length ? "更多…" : "最近用过…"}
          </button>
        )}
      </div>
      {libraryOpen && hasLibrary && (
        <PromptLibrary
          controller={controller}
          notes={notes}
          recent={recent}
          currentPrompt={current}
          onApply={(apply) => { replace(apply); setLibraryOpen(false); }}
        />
      )}
    </div>
  );
}

function PromptLibrary({ controller, notes, recent, currentPrompt, onApply }: {
  controller: PrototypeController;
  notes: PromptNote[];
  recent: PrototypeController["promptHistory"];
  currentPrompt: string;
  onApply: (apply: () => void) => void;
}) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const keyword = query.trim().toLocaleLowerCase();
  const matches = (text: string) => !keyword || text.toLocaleLowerCase().includes(keyword);
  const shownNotes = notes.filter((note) => matches(`${note.title} ${note.prompt}`));
  const shownRecent = recent.filter((entry) => matches(entry.prompt)).slice(0, RECENT_LIMIT);
  const finishRename = (save: boolean) => {
    if (save && renamingId) controller.renameNote(renamingId, renameValue);
    setRenamingId(null);
  };
  const askOrRun = (id: string, run: () => void) => {
    if (confirmId === id) {
      setConfirmId(null);
      run();
    } else {
      setConfirmId(id);
    }
  };
  return (
    <div className="prompt-library">
      {notes.length + recent.length > 8 && (
        <input className="prompt-library__search" type="text" aria-label="搜索提示词" placeholder="搜索" value={query} onChange={(event) => setQuery(event.target.value)} />
      )}
      {notes.length > 0 && <h4>收藏 · {notes.length}</h4>}
      {shownNotes.map((note) => (
        <div className={`prompt-row ${note.prompt === currentPrompt ? "is-current" : ""}`} key={note.id}>
          {renamingId === note.id ? (
            <input
              className="prompt-row__rename"
              aria-label="收藏名称"
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onBlur={() => finishRename(true)}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter") finishRename(true);
                if (event.key === "Escape") finishRename(false);
              }}
            />
          ) : (
            <button className="prompt-row__main" type="button" title="填入提示词" onClick={() => onApply(() => controller.applyPromptNote(note.id))}>
              <strong>{note.title}</strong>
              <small>{note.prompt}</small>
            </button>
          )}
          <button className="prompt-row__action" type="button" title="改名" aria-label={`给「${note.title}」改名`} onClick={() => { setRenamingId(note.id); setRenameValue(note.title); setConfirmId(null); }}>
            <UxpIcon name="edit" />
          </button>
          <button
            className={`prompt-row__action ${confirmId === note.id ? "is-confirm" : ""}`}
            type="button"
            title="删除收藏"
            aria-label={confirmId === note.id ? `确认删除「${note.title}」` : `删除「${note.title}」`}
            onClick={() => askOrRun(note.id, () => controller.deletePromptNote(note.id))}
          >{confirmId === note.id ? "删除?" : <UxpIcon name="close" />}</button>
        </div>
      ))}
      {recent.length > 0 && <h4>最近用过</h4>}
      {shownRecent.map((entry) => (
        <div className={`prompt-row ${entry.prompt === currentPrompt ? "is-current" : ""}`} key={entry.id}>
          <button className="prompt-row__main" type="button" title="填入提示词" onClick={() => onApply(() => controller.applyPromptHistory(entry.id))}>
            <small className="prompt-row__text">{entry.prompt}</small>
          </button>
          <button className="prompt-row__action" type="button" title="收藏" aria-label="收藏这条" onClick={() => controller.favoritePrompt(entry.prompt)}>
            <UxpIcon name="star-outline" />
          </button>
          <button className="prompt-row__action" type="button" title="从最近记录里删掉" aria-label="删除这条记录" onClick={() => controller.deletePromptHistory(entry.id)}>
            <UxpIcon name="close" />
          </button>
        </div>
      ))}
      {keyword && !shownNotes.length && !shownRecent.length && <p className="prompt-library__empty">没有找到</p>}
      {recent.length > 0 && (
        <button
          className={`text-button prompt-library__clear ${confirmId === "history" ? "is-confirm" : ""}`}
          type="button"
          onClick={() => askOrRun("history", controller.clearPromptHistory)}
        >{confirmId === "history" ? "确认清空最近记录" : "清空最近记录"}</button>
      )}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field-row">
      <span className="field-row__label">{label}</span>
      {children}
    </div>
  );
}

export function OutputControls({ controller }: { controller: PrototypeController }) {
  const { draft } = controller;
  if (draft.mode !== "text") {
    return (
      <>
        <FieldRow label="比例">
          <span className="field-row__value">跟随文档 {controller.outputRatio}</span>
        </FieldRow>
        <p className="field-hint">会把当前文档的画面一起发给心宝，结果放在新图层</p>
      </>
    );
  }
  const supportedRatios = controller.currentModelCapability?.aspectRatios ?? [];
  return (
    <>
      <FieldRow label="比例">
        <UxpDropdown
          id="aspect-ratio"
          ariaLabel="输出比例"
          value={draft.aspectRatio === "custom" ? "auto" : draft.aspectRatio}
          options={[
            { value: "auto", label: "自动" },
            ...supportedRatios.map((ratio) => ({ value: ratio, label: ratio })),
          ]}
          onChange={(value) => controller.updateDraft({ aspectRatio: value as typeof draft.aspectRatio })}
        />
      </FieldRow>
      <FieldRow label="放到">
        <UxpDropdown id="output-target" ariaLabel="放到哪里" value={draft.outputTarget} options={[
          { value: "current-document", label: "当前文档（新图层）" },
          { value: "new-document", label: "新建文档" },
        ]} onChange={(value) => controller.updateDraft({ outputTarget: value as "new-document" | "current-document" })} />
      </FieldRow>
    </>
  );
}

function CountStepper({ controller }: { controller: PrototypeController }) {
  const count = controller.draft.count;
  const setEnteredCount = (rawValue: string) => {
    if (!/^\d+$/.test(rawValue)) return;
    controller.setCount(Math.min(4, Math.max(1, Number(rawValue))));
  };
  return (
    <span className="count-stepper" role="group" aria-label="生成数量" title="一次生成几张">
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

function resolutionLabel(value: string) {
  return value === "api-default" ? "默认" : value;
}

function qualityLabel(value: ImageQuality) {
  return `${QUALITY_META[value].label}（${QUALITY_META[value].hint}）`;
}

/** Model, size and quality rarely change, so they fold into one line. */
export function ModelSettings({ controller }: { controller: PrototypeController }) {
  const [open, setOpen] = useState(false);
  const { draft } = controller;
  const capability = controller.currentModelCapability;
  const model = controller.resolvedModel ?? draft.model;
  const resolutions = capability?.resolutions ?? ["api-default"];
  const qualities = capability?.qualityOptions ?? [];
  const quality = qualities.includes(draft.quality) ? draft.quality : qualities[0];
  const modelOptions = controller.settings.modelOptions.filter((option) => option !== "auto");
  const summary = model
    ? [modelDisplayName(model), resolutionLabel(draft.resolution), quality ? QUALITY_META[quality].label : ""].filter(Boolean).join(" · ")
    : "先在设置里填 Key";
  const hint = model === "gpt-image-2"
    ? "G-2.0 实测最大约 1.5K，要更清晰请选 G-2.0 OAI"
    : model === "gpt-image-2-oai"
      ? "1K 到 4K、两档画质都是同一个价"
      : "";
  return (
    <div className={`model-settings ${open ? "is-open" : ""}`}>
      <FieldRow label="参数">
        <button className="summary-button" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span>{summary}</span><b>{open ? "收起" : "修改"}</b>
        </button>
      </FieldRow>
      {open && (
        <div className="model-settings__body">
          <FieldRow label="模型">
            <UxpDropdown id="model" ariaLabel="模型" value={model} options={[
              ...(!model ? [{ value: "", label: "请选择模型" }] : []),
              ...modelOptions.map((option) => {
                const points = pointsPerImage(option);
                return { value: option, label: points == null ? modelDisplayName(option) : `${modelDisplayName(option)} · ${points} 积分/张` };
              }),
            ]} onChange={(value) => controller.updateDraft({ model: value })} />
          </FieldRow>
          <FieldRow label="清晰度">
            <UxpDropdown id="resolution" ariaLabel="清晰度" value={draft.resolution} options={resolutions.map((resolution) => ({
              value: resolution,
              label: resolutionLabel(resolution),
            }))} onChange={(value) => controller.updateDraft({ resolution: value as typeof draft.resolution })} />
          </FieldRow>
          {quality && (
            <FieldRow label="画质">
              <UxpDropdown id="quality" ariaLabel="画质" value={quality} options={qualities.map((option) => ({
                value: option,
                label: qualityLabel(option),
              }))} onChange={(value) => controller.updateDraft({ quality: value as ImageQuality })} />
            </FieldRow>
          )}
          {hint && <p className="field-hint">{hint}</p>}
        </div>
      )}
    </div>
  );
}

export function ReferenceImages({ controller }: { controller: PrototypeController }) {
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
  const references = controller.draft.references;
  const capturing = controller.referenceCaptureStatus === "capturing";
  const full = references.length >= 9;
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
    <section className="references" onMouseUp={finishReferenceDrag} onMouseLeave={finishReferenceDrag}>
      <input ref={inputRef} hidden type="file" multiple accept="image/*" onChange={handleFiles} />
      <div className="references-actions">
        <span className="references-actions__label">参考图{references.length ? ` ${references.length}/9` : " · 可选"}</span>
        {references.length > 0 && (
          <button className="text-button" type="button" aria-label="清空参考图" onClick={controller.clearReferences}>清空</button>
        )}
      </div>
      <div className="reference-add-row">
        <button
          className="reference-add"
          type="button"
          aria-label="添加参考图"
          title={full ? "参考图最多 9 张" : "从电脑里选图片"}
          disabled={full}
          onClick={pickLocal}
        ><UxpIcon name="plus" />本地图片</button>
        <button
          className="reference-add"
          type="button"
          aria-label="添加当前选区"
          title="把 PS 里当前选区截成一张参考图（不会只改选区）"
          disabled={full || capturing}
          onClick={controller.addSelectionReference}
        ><UxpIcon name="plus" />{capturing ? "正在截取…" : "选区截图"}</button>
      </div>
      {references.length > 0 && (
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
          {references.map((image, index) => (
            <div
              className={`reference-item ${dragState?.id === image.id ? "is-dragging" : ""}`.trim()}
              key={image.id}
              title="拖动可以调整顺序"
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
              ><UxpIcon name="close" className="reference-remove-glyph" /></button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function elapsedLabel(seconds: number) {
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export function GenerateAction({ controller }: { controller: PrototypeController }) {
  const active = controller.status === "queued" || controller.status === "running";
  if (active) {
    const stageLabel = {
      idle: "准备中",
      capturing: "正在读取 PS 画面",
      uploading: "正在上传参考图",
      submitting: "正在提交",
      generating: "心宝生成中",
      downloading: "正在下载图片",
      completed: "已完成",
    }[controller.stage];
    return (
      <div className="generation-progress" role="status">
        <div className="generation-progress__line">
          <UxpIcon name="refresh" className="spin" />
          <span>{stageLabel} · 已等 {elapsedLabel(controller.elapsedSeconds)}</span>
          <button type="button" onClick={controller.cancelGeneration}><UxpIcon name="stop" />取消</button>
        </div>
        <i className="generation-progress__bar"><span /></i>
        <small>通常 1–5 分钟，可以先做别的，好了会自动放进来</small>
      </div>
    );
  }
  return (
    <div className="generate-wrap">
      <CountStepper controller={controller} />
      <button className="generate-button" type="button" disabled={Boolean(controller.validationMessage)} onClick={controller.startGeneration}>
        {controller.validationMessage || `生成 ${controller.draft.count} 张${
          controller.pointEstimate == null ? "" : ` · 约 ${controller.pointEstimate} 积分`
        }`}
      </button>
    </div>
  );
}

export function Results({ controller }: { controller: PrototypeController }) {
  const candidates = controller.candidates;
  const kept = candidates.filter((candidate) => candidate.selected);
  const busy = controller.previewStatus === "staging" || controller.previewStatus === "switching" || controller.previewStatus === "committing";
  const previewInPhotoshop = controller.runtimeMode === "uxp" && candidates.some((candidate) => candidate.outputTarget !== "new-document");
  const keepLabel = !kept.length
    ? "勾选要保留的图"
    : kept.length === 1 && kept[0].id === controller.activeCandidateId
      ? "保留这张"
      : `保留 ${kept.length} 张`;
  return (
    <section className="results">
      <div className="results-toolbar">
        <strong>{candidates.length} 张结果</strong>
        <button className="text-button" type="button" onClick={controller.returnToConfiguration}>全不要，返回修改</button>
      </div>
      <p className="field-hint">
        {controller.previewStatus === "staging"
          ? "正在放进 PS 预览…"
          : controller.previewStatus === "switching"
            ? "正在切换预览…"
            : previewInPhotoshop
              ? "点图片在 PS 里预览；想多留几张就勾选"
              : "勾选要保留的图，点 ⌕ 放大看"}
      </p>
      <div className="candidate-grid">
        {candidates.map((candidate, index) => {
          const previewing = candidate.id === controller.activeCandidateId;
          return (
            <article key={candidate.id} className={`${candidate.selected ? "is-selected" : ""} ${previewing ? "is-previewing" : ""}`.trim()}>
              <button className="candidate-select" type="button" role="checkbox" aria-checked={candidate.selected} aria-label={`保留第 ${index + 1} 张`} onClick={() => controller.toggleCandidate(candidate.id)}>
                {candidate.selected && <UxpIcon name="check" />}
              </button>
              <img src={candidate.url} alt={`第 ${index + 1} 张`} onClick={() => controller.activateCandidate(candidate.id)} />
              <button className="candidate-zoom" type="button" aria-label={`放大第 ${index + 1} 张`} onClick={() => controller.setPreviewCandidate(candidate)}>
                <UxpIcon name="zoom" />
              </button>
              <span>第 {index + 1} 张{previewing && previewInPhotoshop ? " · 预览中" : ""}</span>
            </article>
          );
        })}
      </div>
      <button className="insert-button" type="button" disabled={!kept.length || busy} onClick={controller.insertSelected}>
        <UxpIcon name="check" />{keepLabel}
      </button>
      <p className="field-hint field-hint--center">没勾选的不会留在文档里，3 天内可在云端记录找回</p>
    </section>
  );
}

export function WriteRecovery({ controller }: { controller: PrototypeController }) {
  const candidate = controller.candidates[0];
  return (
    <section className="write-recovery" aria-label="图片写入恢复">
      <div className="write-recovery-heading">
        <UxpIcon name="status" />
        <span><strong>图片已生成，还没放进文档</strong><small>图还在，不用重新生成</small></span>
      </div>
      {candidate && <img src={candidate.url} alt="已生成但尚未写入的图片" />}
      {controller.writeError && <p role="alert">{controller.writeError}</p>}
      <div className="write-recovery-actions">
        <button type="button" disabled={controller.writeStatus === "writing"} onClick={controller.retryGeneratedWrite}>
          <UxpIcon name="refresh" />{controller.writeStatus === "writing" ? "正在放进去…" : "再试一次"}
        </button>
        <button type="button" disabled={controller.writeStatus === "writing"} onClick={controller.discardGeneratedResult}>不要了</button>
      </div>
    </section>
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
      <div className="settings-group__heading"><span><UxpIcon name="theme" />外观</span><small>{currentTheme.label}</small></div>
      <div className="theme-grid">
        {THEME_OPTIONS.map((theme) => (
          <button type="button" key={theme.key} aria-label={theme.label} title={`${theme.label} · ${theme.description}`} className={`theme-option theme-option--${theme.key} ${controller.theme === theme.key ? "is-active" : ""}`} onClick={() => controller.setTheme(theme.key)}>
            {controller.theme === theme.key && <UxpIcon name="check" className="theme-check" />}
          </button>
        ))}
      </div>
    </section>
  );
}

function testButtonLabel(status: PrototypeController["settings"]["connectionStatus"]) {
  if (status === "testing") return "检测中…";
  if (status === "connected" || status === "reachable") return "已连接";
  if (status === "failed") return "重新检测";
  return "检测连接";
}

export function GlobalOverlays({ controller }: { controller: PrototypeController }) {
  const status = controller.settings.connectionStatus;
  return (
    <>
      {controller.settingsOpen && (
        <div className="overlay" onMouseDown={() => controller.setSettingsOpen(false)}>
          <aside className="settings-drawer" onMouseDown={(event) => event.stopPropagation()}>
            <header><span><UxpIcon name="settings" />设置</span><button type="button" aria-label="关闭设置" onClick={() => controller.setSettingsOpen(false)}><UxpIcon name="close" className="settings-close-glyph" /></button></header>
            {controller.runtimeMode !== "uxp" && <div className="prototype-notice">浏览器演示：Key 只在这个页面里，不会写入 Photoshop</div>}
            <div className="settings-body">
              <section className="settings-group api-connection-settings">
                <div className="settings-group__heading"><span><UxpIcon name="key" />心宝账号</span></div>
                <label><span>接口地址</span><input value={controller.settings.baseUrl} onChange={(event) => controller.setSettings({ ...controller.settings, baseUrl: event.target.value, connectionStatus: "idle" })} /></label>
                <label><span>Key</span><input type="password" autoComplete="off" placeholder="粘贴心宝给的 Key" value={controller.settings.apiKey} onChange={(event) => controller.setSettings({ ...controller.settings, apiKey: event.target.value, connectionStatus: "idle" })} /><small>{controller.runtimeMode === "uxp" ? "只保存在这台电脑的 PS 里，只发给上面的接口地址" : "只在当前页面里，刷新就没了"}</small></label>
                <div className="settings-actions">
                  <button className={`settings-action settings-action--primary ${controller.credentialSaveStatus === "saved" ? "is-connected" : ""}`} type="button" onClick={controller.saveApiKey} disabled={controller.credentialSaveStatus === "saving"}>
                    <UxpIcon name={controller.credentialSaveStatus === "saving" ? "refresh" : "lock"} className={controller.credentialSaveStatus === "saving" ? "spin" : ""} />
                    {controller.credentialSaveStatus === "saving" ? "正在保存…" : controller.credentialSaveStatus === "saved" ? "已保存" : "保存"}
                  </button>
                  <button className={`settings-action ${status === "connected" || status === "reachable" ? "is-connected" : ""}`} type="button" aria-label="检测连接" onClick={controller.testConnection}>
                    <UxpIcon name={status === "testing" ? "refresh" : "status"} className={status === "testing" ? "spin" : "status-icon"} />
                    {testButtonLabel(status)}
                  </button>
                </div>
              </section>

              <section className="settings-group">
                <div className="settings-group__heading"><span>生成设置</span></div>
                <label className="settings-toggle">
                  <span><strong>记住上次的设置</strong><small>文生图、图生图各记各的</small></span>
                  <input type="checkbox" checked={controller.rememberLastSettings} disabled={!controller.generationSettingsReady} onChange={(event) => controller.setRememberLastSettings(event.target.checked)} />
                </label>
                <button className="settings-action settings-action--compact" type="button" onClick={controller.restoreDefaultGenerationSettings}>恢复默认设置</button>
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
