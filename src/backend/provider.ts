import type {
  GeneratedImageAsset,
  ImageGenerationRequest,
  ProviderConfig,
} from "./contracts";
import type { BalanceSnapshot, CloudTaskRecord, ProviderSnapshot } from "../types";
import {
  createXinbaoSnapshot,
  isXinbaoAsyncBase,
  remoteModelCapabilities,
  xinbaoBalanceBaseUrl,
  xinbaoTaskBatchBaseUrl,
  xinbaoTaskHistoryBaseUrl,
} from "./providerCapabilities";
import {
  remoteRequestCoordinator,
  type RemoteRequestControls,
  type RemoteRequestCoordinator,
} from "../remoteRequestLedger";

interface OutputItem {
  url?: string;
  b64_json?: string;
}

interface ProviderResponse {
  id?: string;
  task_id?: string;
  status?: string;
  polling_url?: string;
  data?: OutputItem[];
  result?: { data?: OutputItem[] };
  error?: { message?: string };
  next_poll_after_ms?: number;
  items?: ProviderResponse[];
}

type CloudTaskPayload = Record<string, unknown> & {
  id?: unknown;
  task_id?: unknown;
  model?: unknown;
  status?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
  create_time?: unknown;
  created_time?: unknown;
  completed_at?: unknown;
  completedAt?: unknown;
  finished_at?: unknown;
  finishedAt?: unknown;
  data?: unknown;
  result?: unknown;
};

interface ProviderDependencies {
  fetchFn?: typeof fetch;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  maxPollAttempts?: number;
  initialPollDelayMs?: number;
  pollIntervalMs?: number;
  requestCoordinator?: RemoteRequestCoordinator;
}

function cloudTaskItems(payload: Record<string, unknown>): unknown[] | null {
  const direct = [payload.items, payload.tasks, payload.data];
  for (const value of direct) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      for (const nestedValue of [nested.items, nested.tasks, nested.data]) {
        if (Array.isArray(nestedValue)) return nestedValue;
      }
    }
  }
  return null;
}

export interface ConnectionTestResult {
  snapshot: ProviderSnapshot;
  balance: BalanceSnapshot;
}

const XINBAO_BANANA_POINT_RATE = 0.00012;
const CLOUD_TASK_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export function recentCloudTasks(tasks: CloudTaskRecord[], now = Date.now()) {
  const cutoff = now - CLOUD_TASK_RETENTION_MS;
  return tasks
    .filter((task) => task.createdAt === null || (task.createdAt >= cutoff && task.createdAt <= now + 60_000))
    .sort((a, b) => {
      if (a.createdAt === null) return b.createdAt === null ? 0 : 1;
      if (b.createdAt === null) return -1;
      return b.createdAt - a.createdAt;
    });
}

function abortError() {
  return new DOMException("已取消", "AbortError");
}

function ensureNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

function defaultSleep(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

export function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  const loopback = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.username || url.password) throw new Error("Base URL 不得包含用户名或密码");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Base URL 必须使用 HTTPS；仅 localhost/127.0.0.1 可使用 HTTP");
  }
  return url.toString().replace(/\/$/, "");
}

export function endpoint(baseUrl: string, path: string) {
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${base}${path.slice(3)}`;
  }
  return `${base}${path}`;
}

function safeMessage(status: number, apiKey: string, fallback = "请求失败") {
  if (status === 401 || status === 403) return `API 鉴权失败（${status}）`;
  const sanitized = (apiKey ? fallback.split(apiKey).join("[REDACTED]") : fallback)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  return `${sanitized}（${status}）`;
}

function responseError(status: number, apiKey: string, fallback?: string) {
  const error = new Error(safeMessage(status, apiKey, fallback));
  if (status === 401 || status === 403) error.name = "AuthenticationError";
  return error;
}

async function parseResponse(response: Response): Promise<ProviderResponse> {
  try {
    return await response.json() as ProviderResponse;
  } catch {
    return {};
  }
}

function decodeBase64(value: string) {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export class OpenAIImageProvider {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly maxPollAttempts: number;
  private readonly initialPollDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly requestCoordinator: RemoteRequestCoordinator;

  constructor(
    private readonly config: ProviderConfig,
    dependencies: ProviderDependencies = {},
  ) {
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.sleep = dependencies.sleep ?? defaultSleep;
    const xinbao = this.isXinbaoAsync();
    this.maxPollAttempts = dependencies.maxPollAttempts ?? (xinbao ? 30 : 60);
    this.initialPollDelayMs = dependencies.initialPollDelayMs ?? (xinbao ? 10_000 : 5_000);
    this.pollIntervalMs = dependencies.pollIntervalMs ?? (xinbao ? 10_000 : 5_000);
    this.requestCoordinator = dependencies.requestCoordinator ?? remoteRequestCoordinator;
  }

  private authHeaders(includeJson = false) {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
      ...(includeJson ? { "Content-Type": "application/json" } : {}),
    };
  }

  async discover(signal: AbortSignal): Promise<ProviderSnapshot> {
    ensureNotAborted(signal);
    if (this.isXinbaoAsync()) {
      const response = await this.fetchFn(endpoint(this.config.baseUrl, "/v1/tasks/batch-get"), {
        method: "POST",
        headers: this.authHeaders(true),
        body: JSON.stringify({ ids: ["img_connection_check"] }),
        signal,
      });
      const data = await parseResponse(response);
      if (!response.ok) throw new Error(safeMessage(response.status, this.config.apiKey, data.error?.message));
      return createXinbaoSnapshot(false);
    }
    const response = await this.fetchFn(endpoint(this.config.baseUrl, "/v1/models"), {
      headers: this.authHeaders(),
      signal,
    });
    const data = await parseResponse(response);
    if (!response.ok) throw new Error(safeMessage(response.status, this.config.apiKey, data.error?.message));
    const models = (data as { data?: Array<Record<string, unknown>> }).data;
    return {
      models: Array.isArray(models) ? remoteModelCapabilities(models) : [],
      credentialVerified: true,
      source: "api",
      fetchedAt: Date.now(),
      stale: false,
    };
  }

  async getBalance(signal: AbortSignal): Promise<BalanceSnapshot> {
    ensureNotAborted(signal);
    const xinbao = this.isXinbaoAsync();
    const points = (value: number | undefined) =>
      value === undefined || !xinbao ? value : value * XINBAO_BANANA_POINT_RATE;
    const balanceBaseUrl = xinbaoBalanceBaseUrl(this.config.baseUrl);
    const creditResponse = await this.fetchFn(endpoint(balanceBaseUrl, "/v1/dashboard/billing/credit_grants"), {
      headers: this.authHeaders(),
      signal,
    });
    if (creditResponse.ok) {
      const data = await this.parseUnknown(creditResponse);
      const total = this.numberValue(data.total_granted);
      const used = this.numberValue(data.total_used);
      const remaining = this.numberValue(data.total_available);
      if (total !== undefined || used !== undefined || remaining !== undefined) {
        const rawRemaining = remaining ?? (total !== undefined && used !== undefined ? total - used : undefined);
        return {
          status: "available",
          total: points(total),
          used: points(used),
          remaining: points(rawRemaining),
          unit: "积分",
          expiresAt: this.numberValue(data.expires_at) ?? null,
          unlimited: total === 100_000_000,
          updatedAt: Date.now(),
        };
      }
    } else if (creditResponse.status !== 404) {
      const data = await parseResponse(creditResponse);
      throw responseError(creditResponse.status, this.config.apiKey, data.error?.message);
    }

    const subscriptionResponse = await this.fetchFn(endpoint(balanceBaseUrl, "/v1/dashboard/billing/subscription"), {
      headers: this.authHeaders(),
      signal,
    });
    if (subscriptionResponse.status === 404) {
      return { status: "unsupported", unit: "积分", updatedAt: Date.now() };
    }
    if (!subscriptionResponse.ok) {
      const data = await parseResponse(subscriptionResponse);
      throw responseError(subscriptionResponse.status, this.config.apiKey, data.error?.message);
    }
    const subscription = await this.parseUnknown(subscriptionResponse);
    const now = new Date();
    const start = new Date(now.getTime() - 86_400_000);
    const date = (value: Date) => `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()}`;
    const usageResponse = await this.fetchFn(endpoint(
      balanceBaseUrl,
      `/v1/dashboard/billing/usage?start_date=${date(start)}&end_date=${date(now)}`,
    ), {
      headers: this.authHeaders(),
      signal,
    });
    if (!usageResponse.ok) {
      const data = await parseResponse(usageResponse);
      throw responseError(usageResponse.status, this.config.apiKey, data.error?.message);
    }
    const usage = await this.parseUnknown(usageResponse);
    const hardLimitUsd = this.numberValue(subscription.hard_limit_usd);
    const totalUsage = this.numberValue(usage.total_usage);
    if (hardLimitUsd === undefined && totalUsage === undefined) {
      return { status: "unsupported", unit: "积分", updatedAt: Date.now() };
    }
    const rawTotal = hardLimitUsd === undefined
      ? undefined
      : hardLimitUsd === 100_000_000
        ? 100_000_000
        : hardLimitUsd * 500_000;
    const rawUsed = totalUsage === undefined ? undefined : totalUsage * 5_000;
    return {
      status: "available",
      total: points(rawTotal),
      used: points(rawUsed),
      remaining: points(rawTotal !== undefined && rawUsed !== undefined ? rawTotal - rawUsed : undefined),
      unit: "积分",
      expiresAt: this.numberValue(subscription.access_until) ?? null,
      unlimited: hardLimitUsd === 100_000_000,
      updatedAt: Date.now(),
    };
  }

  async testConnection(signal: AbortSignal): Promise<ConnectionTestResult> {
    const snapshot = await this.discover(signal);
    let balance: BalanceSnapshot;
    try {
      balance = await this.getBalance(signal);
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      if ((error as Error).name === "AuthenticationError") throw error;
      balance = {
        status: "error",
        unit: "积分",
        updatedAt: Date.now(),
        error: error instanceof Error ? error.message : "余额查询失败",
      };
    }
    return {
      snapshot: {
        ...snapshot,
        credentialVerified: snapshot.credentialVerified || balance.status === "available",
      },
      balance,
    };
  }

  async listTasks(signal: AbortSignal): Promise<CloudTaskRecord[]> {
    ensureNotAborted(signal);
    const historyBaseUrl = this.taskHistoryBaseUrl();
    const response = await this.fetchFn(endpoint(historyBaseUrl, "/api/v1/tasks?limit=100"), {
      headers: this.authHeaders(),
      signal,
    });
    const payload = await this.parseUnknown(response);
    if (!response.ok) throw this.cloudTaskError(response.status);
    const items = cloudTaskItems(payload);
    if (!items) throw new Error("云端记录返回格式无法识别，请稍后重试");
    return recentCloudTasks(this.normalizeCloudTasks(items));
  }

  async getTask(taskId: string, signal: AbortSignal): Promise<CloudTaskRecord> {
    ensureNotAborted(signal);
    const historyBaseUrl = this.taskHistoryBaseUrl();
    const response = await this.fetchFn(endpoint(
      historyBaseUrl,
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
    ), { headers: this.authHeaders(), signal });
    const payload = await this.parseUnknown(response);
    if (!response.ok) throw this.cloudTaskError(response.status);
    const task = this.normalizeCloudTasks([payload])[0];
    if (!task) throw new Error("云端记录缺少有效 taskId");
    return task;
  }

  async batchGetTasks(taskIds: string[], signal: AbortSignal): Promise<CloudTaskRecord[]> {
    ensureNotAborted(signal);
    if (!taskIds.length) return [];
    const batchBaseUrl = this.taskBatchBaseUrl();
    const response = await this.fetchFn(endpoint(batchBaseUrl, "/v1/tasks/batch-get"), {
      method: "POST",
      headers: this.authHeaders(true),
      body: JSON.stringify({ ids: taskIds }),
      signal,
    });
    const payload = await this.parseUnknown(response);
    if (!response.ok) throw this.cloudTaskError(response.status);
    const items = cloudTaskItems(payload);
    if (!items) throw new Error("云端任务返回格式无法识别，请稍后重试");
    return this.normalizeCloudTasks(items);
  }

  async generate(
    request: ImageGenerationRequest,
    signal: AbortSignal,
    onProgress: (value: number) => void = () => undefined,
  ): Promise<GeneratedImageAsset[]> {
    if (request.audit) {
      return this.requestCoordinator.run(
        request.audit,
        request.model,
        (controls) => this.generateOnce(request, signal, onProgress, controls),
      );
    }
    return this.generateOnce(request, signal, onProgress);
  }

  private async generateOnce(
    request: ImageGenerationRequest,
    signal: AbortSignal,
    onProgress: (value: number) => void,
    controls?: RemoteRequestControls,
  ): Promise<GeneratedImageAsset[]> {
    ensureNotAborted(signal);
    await controls?.beforeGenerationPost();
    const response = await this.fetchFn(endpoint(this.config.baseUrl, "/v1/images/generations"), {
      method: "POST",
      headers: this.authHeaders(true),
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        n: request.n,
        response_format: request.responseFormat,
        ...(request.imageUrls?.length ? { image: request.imageUrls } : {}),
        ...(request.size ? { size: request.size } : {}),
        ...(request.quality ? { quality: request.quality } : {}),
      }),
      signal,
    });
    await controls?.generationPostResponded(response.status);
    let data = await parseResponse(response);
    if (!response.ok) throw new Error(safeMessage(response.status, this.config.apiKey, data.error?.message));
    if (Array.isArray(data.data)) {
      await controls?.setStatus("downloading");
      return this.download(data.data, signal);
    }

    const taskId = data.id ?? data.task_id;
    if (!taskId) throw new Error("API 未返回图片或任务 ID");
    await controls?.taskAccepted(taskId);
    const xinbao = this.isXinbaoAsync();
    const pollingUrl = xinbao
      ? endpoint(this.config.baseUrl, "/v1/tasks/batch-get")
      : this.pollingEndpoint(data.polling_url, taskId);
    let nextDelayMs = this.initialPollDelayMs;
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      ensureNotAborted(signal);
      await this.sleep(nextDelayMs, signal);
      let pollResponse: Response;
      try {
        pollResponse = await this.fetchFn(pollingUrl, {
          ...(xinbao ? {
            method: "POST",
            headers: this.authHeaders(true),
            body: JSON.stringify({ ids: [taskId] }),
          } : {
            headers: this.authHeaders(),
          }),
          signal,
        });
      } catch (error) {
        ensureNotAborted(signal);
        onProgress(Math.min(95, 10 + Math.round((attempt + 1) * 85 / this.maxPollAttempts)));
        nextDelayMs = this.pollIntervalMs;
        continue;
      }
      const pollingData = await parseResponse(pollResponse);
      if (!pollResponse.ok) {
        throw new Error(safeMessage(pollResponse.status, this.config.apiKey, pollingData.error?.message));
      }
      data = xinbao
        ? pollingData.items?.find((item) => item.id === taskId) ?? pollingData.items?.[0] ?? {}
        : pollingData;
      const status = String(data.status ?? "running").trim().toLowerCase();
      if (["succeeded", "completed", "success"].includes(status)) {
        await controls?.setStatus("downloading");
        return this.download(data.result?.data ?? data.data ?? [], signal);
      }
      if (status === "uncertain") {
        throw new Error("任务状态不确定，可能已由上游处理；请勿自动重复提交");
      }
      if (["failed", "error", "cancelled", "canceled", "not_found"].includes(status)) {
        await controls?.setStatus("failed");
        throw new Error(`图片任务失败（${status}）`);
      }
      onProgress(Math.min(95, 10 + Math.round((attempt + 1) * 85 / this.maxPollAttempts)));
      const retryAfterSeconds = Number(pollResponse.headers.get("retry-after") || 0);
      nextDelayMs = Math.max(
        this.pollIntervalMs,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0,
        Number(pollingData.next_poll_after_ms || data.next_poll_after_ms || 0),
      );
    }
    throw new Error("图片任务轮询超时");
  }

  private isXinbaoAsync() {
    return isXinbaoAsyncBase(normalizeBaseUrl(this.config.baseUrl));
  }

  private taskHistoryBaseUrl() {
    const baseUrl = xinbaoTaskHistoryBaseUrl(this.config.baseUrl);
    if (!baseUrl) throw new Error("当前渠道不支持云端任务记录");
    return baseUrl;
  }

  private taskBatchBaseUrl() {
    const baseUrl = xinbaoTaskBatchBaseUrl(this.config.baseUrl);
    if (!baseUrl) throw new Error("当前渠道不支持云端任务记录");
    return baseUrl;
  }

  private async parseUnknown(response: Response): Promise<Record<string, unknown>> {
    try {
      const value = await response.json();
      return value && typeof value === "object" ? value as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private numberValue(value: unknown) {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  private cloudTaskError(status: number) {
    if (status === 401 || status === 403) return new Error(`云端记录鉴权失败（${status}）`);
    if (status === 429) return new Error("云端记录请求过于频繁（429），请稍后手动刷新");
    return new Error(`云端记录接口不可用（${status}）`);
  }

  private normalizeCloudTasks(items: unknown[]): CloudTaskRecord[] {
    return items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const task = item as CloudTaskPayload;
      const taskId = typeof task.id === "string" || typeof task.id === "number"
        ? String(task.id)
        : typeof task.task_id === "string" || typeof task.task_id === "number"
          ? String(task.task_id)
          : "";
      if (!taskId) return [];
      const result = task.result && typeof task.result === "object" ? task.result as Record<string, unknown> : {};
      const rawData = Array.isArray(result.data) ? result.data : Array.isArray(task.data) ? task.data : [];
      const first = rawData[0] && typeof rawData[0] === "object" ? rawData[0] as Record<string, unknown> : {};
      const normalizeNumericTimestamp = (value: number) => {
        if (!Number.isFinite(value) || value <= 0) return null;
        if (value >= 100_000_000_000_000) return value / 1000;
        if (value < 10_000_000_000) return value * 1000;
        return value;
      };
      const timestamp = (value: unknown) => {
        if (typeof value === "number") return normalizeNumericTimestamp(value);
        if (typeof value === "string") {
          const numeric = Number(value);
          if (Number.isFinite(numeric)) return normalizeNumericTimestamp(numeric);
          const parsed = Date.parse(value);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      };
      return [{
        taskId,
        model: typeof task.model === "string" ? task.model : "未知模型",
        status: typeof task.status === "string" ? task.status : "unknown",
        createdAt: timestamp(task.created_at ?? task.createdAt ?? task.create_time ?? task.created_time),
        completedAt: timestamp(task.completed_at ?? task.completedAt ?? task.finished_at ?? task.finishedAt),
        thumbnailUrl: typeof first.url === "string" ? first.url : null,
        origin: "external-or-unknown" as const,
      }];
    });
  }

  private pollingEndpoint(value: string | undefined, taskId: string) {
    if (!value) return endpoint(this.config.baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}`);
    const resolved = new URL(value, `${normalizeBaseUrl(this.config.baseUrl)}/`);
    if (resolved.origin !== new URL(normalizeBaseUrl(this.config.baseUrl)).origin) {
      throw new Error("API 返回了不受信任的轮询地址");
    }
    return resolved.toString();
  }

  private async download(items: OutputItem[], signal: AbortSignal) {
    if (!items.length) throw new Error("API 任务成功但没有返回图片");
    return Promise.all(items.map(async (item, index): Promise<GeneratedImageAsset> => {
      ensureNotAborted(signal);
      if (item.b64_json) {
        return { id: `generated-${index}`, bytes: decodeBase64(item.b64_json), mimeType: "image/png" };
      }
      if (!item.url) throw new Error("API 返回了无法识别的图片结果");
      const response = await this.fetchFn(item.url, { signal });
      if (!response.ok) throw new Error(`下载生成图片失败（${response.status}）`);
      const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (!mimeType?.startsWith("image/")) {
        throw new Error("API 返回的文件不是图片");
      }
      if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(mimeType)) {
        throw new Error(`API 返回了不支持的图片格式（${mimeType}）`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) throw new Error("API 返回了空图片文件");
      return {
        id: `generated-${index}`,
        bytes,
        mimeType,
      };
    }));
  }
}
