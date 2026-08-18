import { useCallback, useEffect, useRef, useState } from "react";
import { generationModel } from "../backend/generationService";
import { OpenAIImageProvider } from "../backend/provider";
import { snapshotModelOptions } from "../backend/providerCapabilities";
import { createCredentialStore } from "../backend/runtime";
import type { BalanceSnapshot, ConnectionSettings, ToastMessage } from "../types";

type ProviderSnapshot = NonNullable<ConnectionSettings["providerSnapshot"]>;
type ProviderClient = Pick<OpenAIImageProvider, "discover" | "getBalance" | "testConnection">;
type CredentialStore = {
  loadApiKey: () => Promise<string>;
  saveApiKey: (apiKey: string) => Promise<void>;
  deleteApiKey: () => Promise<void>;
};
type Notify = (text: string, kind?: ToastMessage["kind"]) => void;
const DEFAULT_CREDENTIAL_STORE = createCredentialStore();

export const EMPTY_CONNECTION_BALANCE: BalanceSnapshot = { status: "idle", unit: "积分" };

export function resetProviderConnection(current: ConnectionSettings, next: ConnectionSettings) {
  const changed = next.apiKey !== current.apiKey || next.baseUrl !== current.baseUrl;
  return changed
    ? { ...next, connectionStatus: "idle" as const, modelOptions: [], providerSnapshot: null }
    : next;
}

export function providerConnectionStatus(snapshot: ProviderSnapshot, balance: BalanceSnapshot) {
  return snapshot.credentialVerified || balance.status === "available"
    ? "connected" as const
    : "reachable" as const;
}

interface UseConnectionSettingsOptions {
  initialSettings: ConnectionSettings;
  initialBalance?: BalanceSnapshot;
  credentialStore?: CredentialStore;
  providerFactory?: (settings: ConnectionSettings) => ProviderClient;
  notify: Notify;
  onIdentityChange?: () => void;
  onSnapshot?: (snapshot: ProviderSnapshot, modelOptions: string[]) => void;
}

export interface ConnectionSettingsController {
  settings: ConnectionSettings;
  balance: BalanceSnapshot;
  credentialSaveStatus: "idle" | "saving" | "saved" | "error";
  setSettings: (next: ConnectionSettings) => void;
  saveApiKey: () => Promise<void>;
  refreshBalance: (showLoading?: boolean) => void;
  refreshModels: (showToast?: boolean) => void;
  testConnection: () => void;
}

export function useConnectionSettings({
  initialSettings,
  initialBalance = EMPTY_CONNECTION_BALANCE,
  credentialStore = DEFAULT_CREDENTIAL_STORE,
  providerFactory,
  notify,
  onIdentityChange,
  onSnapshot,
}: UseConnectionSettingsOptions): ConnectionSettingsController {
  const [settings, setSettingsState] = useState(initialSettings);
  const [balance, setBalance] = useState(initialBalance);
  const [credentialSaveStatus, setCredentialSaveStatus] = useState<ConnectionSettingsController["credentialSaveStatus"]>("idle");
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const balanceRef = useRef(balance);
  balanceRef.current = balance;
  const credentialEditedRef = useRef(false);
  const providerAbortRef = useRef<AbortController | null>(null);
  const balanceAbortRef = useRef<AbortController | null>(null);
  const onIdentityChangeRef = useRef(onIdentityChange);
  onIdentityChangeRef.current = onIdentityChange;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;

  const createProvider = useCallback((current: ConnectionSettings) => (
    providerFactory?.(current) ?? new OpenAIImageProvider({
      baseUrl: current.baseUrl,
      apiKey: current.apiKey.trim(),
      model: generationModel(current.modelOptions[0] ?? "", current.modelOptions, current.providerSnapshot),
    })
  ), [providerFactory]);

  const setSettings = useCallback((next: ConnectionSettings) => {
    const current = settingsRef.current;
    const identityChanged = next.apiKey !== current.apiKey || next.baseUrl !== current.baseUrl;
    if (!identityChanged) {
      settingsRef.current = next;
      setSettingsState(next);
      return;
    }
    if (next.apiKey !== current.apiKey) credentialEditedRef.current = true;
    providerAbortRef.current?.abort();
    balanceAbortRef.current?.abort();
    setCredentialSaveStatus("idle");
    setBalance(EMPTY_CONNECTION_BALANCE);
    const reset = resetProviderConnection(current, next);
    settingsRef.current = reset;
    setSettingsState(reset);
    onIdentityChangeRef.current?.();
  }, []);

  const commitSnapshot = useCallback((snapshot: ProviderSnapshot, baseUrl: string, apiKey: string) => {
    const current = settingsRef.current;
    if (current.baseUrl !== baseUrl || current.apiKey.trim() !== apiKey) return;
    const modelOptions = snapshotModelOptions(snapshot);
    setSettingsState((value) => {
      const next = {
        ...value,
        connectionStatus: providerConnectionStatus(snapshot, balanceRef.current),
        providerSnapshot: snapshot,
        modelOptions,
      };
      settingsRef.current = next;
      return next;
    });
    onSnapshotRef.current?.(snapshot, modelOptions);
  }, []);

  const refreshBalance = useCallback((showLoading = true) => {
    const current = settingsRef.current;
    const apiKey = current.apiKey.trim();
    if (!apiKey) {
      setBalance(EMPTY_CONNECTION_BALANCE);
      return;
    }
    balanceAbortRef.current?.abort();
    const controller = new AbortController();
    balanceAbortRef.current = controller;
    if (showLoading) setBalance((previous) => ({ ...previous, status: "loading", unit: "积分", error: undefined }));
    void createProvider(current).getBalance(controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      if (settingsRef.current.baseUrl !== current.baseUrl || settingsRef.current.apiKey.trim() !== apiKey) return;
      setBalance(next);
      if (next.status === "available") {
        setSettingsState((value) => {
          const updated = { ...value, connectionStatus: "connected" as const };
          settingsRef.current = updated;
          return updated;
        });
      }
    }).catch((requestError) => {
      if (controller.signal.aborted || (requestError as Error).name === "AbortError") return;
      if (settingsRef.current.baseUrl !== current.baseUrl || settingsRef.current.apiKey.trim() !== apiKey) return;
      setBalance({
        status: "error",
        unit: "积分",
        updatedAt: Date.now(),
        error: requestError instanceof Error ? requestError.message : "余额查询失败",
      });
      if ((requestError as Error).name === "AuthenticationError") {
        setSettingsState((value) => ({ ...value, connectionStatus: "failed" }));
      }
    }).finally(() => {
      if (balanceAbortRef.current === controller) balanceAbortRef.current = null;
    });
  }, [createProvider]);

  const refreshModels = useCallback((showToast = true) => {
    const current = settingsRef.current;
    const apiKey = current.apiKey.trim();
    if (!apiKey) {
      if (showToast) notify("请先填写 API Key", "warning");
      return;
    }
    providerAbortRef.current?.abort();
    const controller = new AbortController();
    providerAbortRef.current = controller;
    setSettingsState((value) => ({ ...value, connectionStatus: "testing" }));
    void createProvider(current).discover(controller.signal).then((snapshot) => {
      if (controller.signal.aborted) return;
      commitSnapshot(snapshot, current.baseUrl, apiKey);
      if (showToast) notify(`已刷新 ${snapshot.models.length} 个模型`, "success");
    }).catch((requestError) => {
      if (controller.signal.aborted || (requestError as Error).name === "AbortError") return;
      const latest = settingsRef.current;
      if (latest.baseUrl !== current.baseUrl || latest.apiKey.trim() !== apiKey) return;
      setSettingsState((value) => ({
        ...value,
        connectionStatus: "failed",
        providerSnapshot: value.providerSnapshot ? { ...value.providerSnapshot, source: "cache", stale: true } : null,
      }));
      if (showToast) notify(requestError instanceof Error ? requestError.message : "模型刷新失败", "warning");
    }).finally(() => {
      if (providerAbortRef.current === controller) providerAbortRef.current = null;
    });
  }, [commitSnapshot, createProvider, notify]);

  const testConnection = useCallback(() => {
    const current = settingsRef.current;
    const apiKey = current.apiKey.trim();
    if (!apiKey) {
      notify("请先填写 API Key", "warning");
      return;
    }
    providerAbortRef.current?.abort();
    balanceAbortRef.current?.abort();
    const controller = new AbortController();
    providerAbortRef.current = controller;
    setSettingsState((value) => ({ ...value, connectionStatus: "testing" }));
    setBalance((previous) => ({ ...previous, status: "loading", unit: "积分", error: undefined }));
    void createProvider(current).testConnection(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      commitSnapshot(result.snapshot, current.baseUrl, apiKey);
      if (settingsRef.current.baseUrl === current.baseUrl && settingsRef.current.apiKey.trim() === apiKey) {
        setBalance(result.balance);
      }
      notify(result.snapshot.credentialVerified ? "API 连接及凭据验证正常" : "API 服务可达", result.snapshot.credentialVerified ? "success" : "info");
    }).catch((requestError) => {
      if (controller.signal.aborted || (requestError as Error).name === "AbortError") return;
      setSettingsState((value) => ({ ...value, connectionStatus: "failed" }));
      setBalance({ status: "error", unit: "积分", updatedAt: Date.now(), error: requestError instanceof Error ? requestError.message : "连接测试失败" });
      notify(requestError instanceof Error ? requestError.message : "连接测试失败", "warning");
    }).finally(() => {
      if (providerAbortRef.current === controller) providerAbortRef.current = null;
    });
  }, [commitSnapshot, createProvider, notify]);

  const saveApiKey = useCallback(async () => {
    setCredentialSaveStatus("saving");
    try {
      const apiKey = settingsRef.current.apiKey.trim();
      if (apiKey) await credentialStore.saveApiKey(apiKey);
      else await credentialStore.deleteApiKey();
      setCredentialSaveStatus("saved");
      notify(apiKey ? "API Key 已安全保存" : "已删除保存的 API Key", "success");
    } catch {
      setCredentialSaveStatus("error");
      notify("API Key 安全存储写入失败", "warning");
    }
  }, [credentialStore, notify]);

  useEffect(() => {
    let disposed = false;
    void credentialStore.loadApiKey().then((apiKey) => {
      if (disposed || credentialEditedRef.current || !apiKey) return;
      setSettingsState((current) => {
        const next = { ...current, apiKey };
        settingsRef.current = next;
        return next;
      });
      setCredentialSaveStatus("saved");
    }).catch(() => notify("无法读取 UXP 安全存储中的 API Key", "warning"));
    return () => { disposed = true; };
  }, [credentialStore, notify]);

  useEffect(() => {
    if (credentialSaveStatus !== "saved" || !settings.apiKey.trim()) return;
    refreshModels(false);
    refreshBalance(false);
  }, [credentialSaveStatus, refreshBalance, refreshModels, settings.apiKey, settings.baseUrl]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return undefined;
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") refreshBalance(false);
    };
    const timer = window.setInterval(refreshWhenVisible, 60_000);
    document.addEventListener?.("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener?.("visibilitychange", refreshWhenVisible);
    };
  }, [refreshBalance]);

  useEffect(() => () => {
    providerAbortRef.current?.abort();
    balanceAbortRef.current?.abort();
  }, []);

  return { settings, balance, credentialSaveStatus, setSettings, saveApiKey, refreshBalance, refreshModels, testConnection };
}
