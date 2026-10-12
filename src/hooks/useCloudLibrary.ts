import { useEffect, useRef, useState } from "react";
import { OpenAIImageProvider } from "../backend/provider";
import type { GeneratedImageAsset, PhotoshopWriter } from "../backend/contracts";
import { saveGeneratedImage } from "../backend/runtime";
import type { CloudTaskRecord, OutputTarget } from "../types";

type Phase = "idle" | "downloading" | "ready" | "writing" | "saving" | "done" | "error";
type State = { task: CloudTaskRecord | null; index: number; phase: Phase; url: string | null; message: string };
type Dependencies = {
  settings: { baseUrl: string; apiKey: string };
  writer: Pick<PhotoshopWriter, "getContext" | "insert">;
  runtimeMode: "uxp" | "browser";
  recover?: OpenAIImageProvider["recoverTaskImage"];
  save?: typeof saveGeneratedImage;
};

export function useCloudLibrary({ settings, writer, runtimeMode, recover, save }: Dependencies) {
  const initial: State = { task: null, index: 0, phase: "idle", url: null, message: "" };
  const [state, setState] = useState<State>(initial);
  const stateRef = useRef(state);
  stateRef.current = state;
  const assetRef = useRef<GeneratedImageAsset | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const revisionRef = useRef(0);
  const busyRef = useRef(false);
  const writingRef = useRef(false);
  const disposedRef = useRef(false);
  const patch = (update: Partial<State>) => {
    stateRef.current = { ...stateRef.current, ...update };
    if (!disposedRef.current) setState(stateRef.current);
  };
  const release = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    assetRef.current = null;
  };
  const close = () => {
    if (writingRef.current) return;
    revisionRef.current += 1;
    abortRef.current?.abort();
    busyRef.current = false;
    release();
    patch(initial);
  };
  const select = async (task: CloudTaskRecord, index = 0) => {
    if (writingRef.current) return;
    abortRef.current?.abort();
    const revision = ++revisionRef.current;
    const abort = new AbortController();
    abortRef.current = abort;
    busyRef.current = true;
    release();
    patch({ task, index, phase: "downloading", url: null, message: "正在取回原图…" });
    const timeout = setTimeout(() => abort.abort(), 90_000);
    try {
      const provider = new OpenAIImageProvider({ ...settings, model: "auto" });
      const result = await (recover ?? provider.recoverTaskImage.bind(provider))(task.taskId, index, abort.signal);
      if (revision !== revisionRef.current || abort.signal.aborted) return;
      assetRef.current = result.asset;
      const bytes = new Uint8Array(result.asset.bytes).buffer;
      urlRef.current = URL.createObjectURL(new Blob([bytes], { type: result.asset.mimeType }));
      patch({ task: { ...result.task, origin: task.origin }, url: urlRef.current, phase: "ready", message: "" });
    } catch (error) {
      if (revision !== revisionRef.current) return;
      patch({ phase: "error", message: abort.signal.aborted ? "取回超时，请重试" : error instanceof Error ? error.message : "取回失败" });
    } finally {
      clearTimeout(timeout);
      if (revision === revisionRef.current) {
        busyRef.current = false;
        if (abort.signal.aborted && stateRef.current.phase === "downloading") patch({ phase: "error", message: "取回超时，请重试" });
      }
    }
  };
  const transfer = async (target: OutputTarget | "save") => {
    if (busyRef.current || !assetRef.current || !stateRef.current.task) return;
    if (runtimeMode !== "uxp" && target !== "save") {
      patch({ message: "请在 Photoshop 中执行此操作" });
      return;
    }
    busyRef.current = true;
    writingRef.current = true;
    const revision = revisionRef.current;
    const asset = assetRef.current;
    const task = stateRef.current.task;
    patch({ phase: target === "save" ? "saving" : "writing", message: target === "save" ? "正在保存…" : "正在写入 Photoshop…" });
    try {
      if (target === "save") {
        const saved = await (save ?? saveGeneratedImage)(asset);
        if (revision === revisionRef.current) patch({ phase: saved ? "done" : "ready", message: saved ? "已保存到本地" : "已取消保存" });
      } else {
        const context = target === "current-document" ? await writer.getContext() : null;
        if (target === "current-document" && !context?.documentId) throw new Error("请先打开目标文档，或选择新建文档");
        if (revision !== revisionRef.current || disposedRef.current) return;
        await writer.insert([asset], target, context?.documentId, {
          documentId: context?.documentId ?? `cloud-${task.taskId}`,
          jobId: `cloud-${task.taskId}`, revision, ownerPrefix: "ps-fill",
        });
        if (revision === revisionRef.current) patch({ phase: "done", message: target === "current-document" ? "已插入当前文档" : "已打开新文档" });
      }
    } catch (error) {
      if (revision === revisionRef.current) patch({ phase: "error", message: error instanceof Error ? error.message : "写入失败，原图仍保留，可重试" });
    } finally {
      busyRef.current = false;
      writingRef.current = false;
    }
  };
  useEffect(() => {
    revisionRef.current += 1;
    abortRef.current?.abort();
    release();
    patch(initial);
    if (!writingRef.current) busyRef.current = false;
  }, [settings.baseUrl, settings.apiKey]);
  useEffect(() => {
    disposedRef.current = false;
    return () => { disposedRef.current = true; revisionRef.current += 1; abortRef.current?.abort(); release(); };
  }, []);
  return { ...state, hasAsset: !!assetRef.current, select, close, transfer,
    busy: ["downloading", "writing", "saving"].includes(state.phase),
    writing: ["writing", "saving"].includes(state.phase) };
}

export type CloudLibraryController = ReturnType<typeof useCloudLibrary>;
