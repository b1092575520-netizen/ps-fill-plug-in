import { describe, expect, it, vi } from "vitest";
import { OpenAIImageProvider, normalizeBaseUrl, recentCloudTasks } from "../src/backend/provider";
import { RemoteRequestCoordinator } from "../src/remoteRequestLedger";

const config = {
  baseUrl: "https://async.xinbao-ai.com",
  apiKey: "test-private-value",
  model: "gpt-image-2-oai",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAIImageProvider", () => {
  it("keeps recent cloud history and retains unknown-time records at the end", () => {
    const now = Date.UTC(2026, 7, 14, 10, 0, 0);
    const record = (taskId: string, createdAt: number | null) => ({
      taskId,
      model: "gpt-image-2-oai",
      status: "succeeded",
      createdAt,
      completedAt: createdAt,
      thumbnailUrl: null,
      origin: "external-or-unknown" as const,
    });
    expect(recentCloudTasks([
      record("old", now - 3 * 24 * 60 * 60 * 1000 - 1),
      record("unknown", null),
      record("recent-a", now - 2_000),
      record("recent-b", now - 1_000),
    ], now).map((item) => item.taskId)).toEqual(["recent-b", "recent-a", "unknown"]);
  });

  it("normalizes camelCase provider timestamps instead of silently dropping the task", async () => {
    const createdAt = new Date(Date.now() - 2_000).toISOString();
    const completedAt = new Date(Date.now() - 1_000).toISOString();
    const provider = new OpenAIImageProvider(config, {
      fetchFn: vi.fn().mockResolvedValueOnce(json({ items: [{
        id: "camel-time",
        model: "gpt-image-2-oai",
        status: "succeeded",
        createdAt,
        completedAt,
      }] })),
    });

    await expect(provider.listTasks(new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({ taskId: "camel-time", createdAt: Date.parse(createdAt), completedAt: Date.parse(completedAt) }),
    ]);
  });

  it("accepts HTTPS and loopback HTTP only", () => {
    expect(normalizeBaseUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeBaseUrl("http://127.0.0.1:8317/v1/")).toBe("http://127.0.0.1:8317/v1");
    expect(() => normalizeBaseUrl("http://example.com")).toThrow(/HTTPS/);
  });

  it("downloads synchronous URL and base64 results", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ data: [
        { url: "https://cdn.example/a.png" },
        { b64_json: btoa("image-b") },
      ] }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      }));
    const provider = new OpenAIImageProvider(config, { fetchFn });
    const results = await provider.generate({
      prompt: "test", model: "gpt-image-2-oai", n: 2, responseFormat: "url",
    }, new AbortController().signal);

    expect(results).toHaveLength(2);
    expect(Array.from(results[0].bytes)).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(results[1].bytes)).toBe("image-b");
    expect(fetchFn.mock.calls[1][1]?.headers).toBeUndefined();
  });

  it("submits the same paid local request exactly once at the fetch boundary", async () => {
    const fetchFn = vi.fn(async () => json({
      data: [{ b64_json: btoa("done") }],
    }));
    const provider = new OpenAIImageProvider(config, { fetchFn });
    const request = {
      prompt: "single paid intent",
      model: "gpt-image-2-oai",
      n: 1,
      responseFormat: "url" as const,
      audit: {
        localRequestId: "local-request-1",
        documentId: "doc-a",
        mode: "text" as const,
        submittedAt: Date.now(),
        promptHash: "sha256:test",
      },
    };

    await expect(Promise.all([
      provider.generate(request, new AbortController().signal),
      provider.generate(request, new AbortController().signal),
    ])).resolves.toHaveLength(2);

    const generationPosts = fetchFn.mock.calls.filter(([url, init]) => (
      String(url).endsWith("/v1/images/generations") && init?.method === "POST"
    ));
    expect(generationPosts).toHaveLength(1);
  });

  it("blocks another document clicked six seconds later before its paid fetch", async () => {
    const coordinator = new RemoteRequestCoordinator({
      load: async () => [],
      save: async () => undefined,
    });
    let finishFirst!: () => void;
    const firstFetch = vi.fn(() => new Promise<Response>((resolve) => {
      finishFirst = () => resolve(json({ data: [{ b64_json: btoa("first") }] }));
    }));
    const secondFetch = vi.fn(async () => json({ data: [{ b64_json: btoa("second") }] }));
    const firstProvider = new OpenAIImageProvider(config, { fetchFn: firstFetch, requestCoordinator: coordinator });
    const secondProvider = new OpenAIImageProvider(config, { fetchFn: secondFetch, requestCoordinator: coordinator });
    const baseRequest = {
      prompt: "paid intent",
      model: "gpt-image-2-oai",
      n: 1,
      responseFormat: "url" as const,
    };
    const firstSubmittedAt = Date.now();
    const first = firstProvider.generate({
      ...baseRequest,
      audit: {
        localRequestId: "request-a",
        documentId: "doc-a",
        mode: "text" as const,
        submittedAt: firstSubmittedAt,
        promptHash: "sha256:a",
      },
    }, new AbortController().signal);
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledOnce());

    await expect(secondProvider.generate({
      ...baseRequest,
      audit: {
        localRequestId: "request-b",
        documentId: "doc-b",
        mode: "text" as const,
        submittedAt: firstSubmittedAt + 6_000,
        promptHash: "sha256:b",
      },
    }, new AbortController().signal)).rejects.toThrow("已有一个付费远程任务");
    expect(secondFetch).not.toHaveBeenCalled();

    finishFirst();
    await expect(first).resolves.toHaveLength(1);
  });

  it("rejects downloaded responses that are not images", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ data: [{ url: "https://cdn.example/not-image" }] }))
      .mockResolvedValueOnce(new Response("<html>upstream error</html>", {
        headers: { "content-type": "text/html" },
      }));
    const provider = new OpenAIImageProvider(config, { fetchFn });

    await expect(provider.generate({
      prompt: "test", model: "gpt-image-2-oai", n: 1, responseFormat: "url",
    }, new AbortController().signal)).rejects.toThrow("API 返回的文件不是图片");
  });

  it("sends reference URLs with the documented image field", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      data: [{ b64_json: btoa("done") }],
    }));
    const provider = new OpenAIImageProvider(config, { fetchFn });
    await provider.generate({
      prompt: "test",
      model: "gpt-image-2-oai",
      imageUrls: ["https://temp.example/a.png", "https://temp.example/b.jpg"],
      n: 1,
      responseFormat: "url",
    }, new AbortController().signal);
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    expect(body.image).toEqual([
      "https://temp.example/a.png",
      "https://temp.example/b.jpg",
    ]);
  });

  it("polls Xinbao-shaped asynchronous tasks", async () => {
    const delays: number[] = [];
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ id: "task-1", polling_url: "/v1/tasks/task-1" }))
      .mockResolvedValueOnce(json({ items: [{ id: "task-1", status: "running" }] }))
      .mockResolvedValueOnce(json({ items: [{
        id: "task-1",
        status: "succeeded",
        result: { data: [{ b64_json: btoa("done") }] },
      }] }));
    const provider = new OpenAIImageProvider(config, {
      fetchFn,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      maxPollAttempts: 3,
    });
    const progress: number[] = [];
    const results = await provider.generate({
      prompt: "test", model: "gpt-image-2-oai", n: 1, responseFormat: "url",
    }, new AbortController().signal, (value) => progress.push(value));

    expect(new TextDecoder().decode(results[0].bytes)).toBe("done");
    expect(progress.length).toBeGreaterThan(0);
    expect(delays).toEqual([10_000, 10_000]);
    expect(String(fetchFn.mock.calls[1][0])).toContain("/v1/tasks/batch-get");
    expect(fetchFn.mock.calls[1][1]?.method).toBe("POST");
  });

  it("uses documented Xinbao batch-get for a no-cost connection check", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      object: "batch.task.list",
      items: [{ id: "img_connection_check", status: "not_found" }],
    }));
    const provider = new OpenAIImageProvider(config, { fetchFn });
    await expect(provider.testConnection(new AbortController().signal)).resolves.toMatchObject({
      snapshot: {
        models: expect.arrayContaining([
          expect.objectContaining({ id: "gpt-image-2-oai", confirmedImage: true }),
        ]),
        credentialVerified: false,
      },
      balance: { status: "error" },
    });
    expect(String(fetchFn.mock.calls[0][0])).toContain("/v1/tasks/batch-get");
    expect(fetchFn.mock.calls[0][1]?.method).toBe("POST");
  });

  it("lists the latest cloud tasks without making a generation request", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ items: [{
      id: "task-cloud-1",
      model: "gpt-image-2-oai",
      status: "succeeded",
      created_at: new Date(Date.now() - 2_000).toISOString(),
      completed_at: Date.now() - 1_000,
      result: { data: [{ url: "https://cdn.example/cloud-1.png" }] },
    }] }));
    const provider = new OpenAIImageProvider(config, { fetchFn });
    const records = await provider.listTasks(new AbortController().signal);

    expect(records).toEqual([expect.objectContaining({
      taskId: "task-cloud-1",
      model: "gpt-image-2-oai",
      status: "succeeded",
      thumbnailUrl: "https://cdn.example/cloud-1.png",
      origin: "external-or-unknown",
    })]);
    expect(String(fetchFn.mock.calls[0][0])).toBe("https://task.xinbao-ai.com/api/v1/tasks?limit=100");
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({ Authorization: expect.stringMatching(/^Bearer /) });
    expect(String(fetchFn.mock.calls[0][0])).not.toContain(config.apiKey);
    expect(fetchFn.mock.calls[0][1]?.body).toBeUndefined();
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/images/generations"))).toBe(false);
  });

  it("returns an empty cloud record list and reports 401 or 429 clearly", async () => {
    const empty = new OpenAIImageProvider(config, { fetchFn: vi.fn(async () => json({ items: [] })) });
    await expect(empty.listTasks(new AbortController().signal)).resolves.toEqual([]);

    const unauthorized = new OpenAIImageProvider(config, { fetchFn: vi.fn(async () => json({}, 401)) });
    await expect(unauthorized.listTasks(new AbortController().signal)).rejects.toThrow("云端记录鉴权失败（401）");

    const limited = new OpenAIImageProvider(config, { fetchFn: vi.fn(async () => json({}, 429)) });
    await expect(limited.listTasks(new AbortController().signal)).rejects.toThrow("请求过于频繁（429）");
  });

  it("gets task detail and uses batch-get only for task history", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ id: "task-detail", status: "running", model: "gpt-image-2" }))
      .mockResolvedValueOnce(json({ items: [{ id: "task-detail", status: "succeeded", model: "gpt-image-2" }] }));
    const provider = new OpenAIImageProvider(config, { fetchFn });

    await expect(provider.getTask("task-detail", new AbortController().signal)).resolves.toMatchObject({ taskId: "task-detail" });
    await expect(provider.batchGetTasks(["task-detail"], new AbortController().signal)).resolves.toHaveLength(1);
    expect(String(fetchFn.mock.calls[0][0])).toBe("https://task.xinbao-ai.com/api/v1/tasks/task-detail");
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${config.apiKey}` });
    expect(String(fetchFn.mock.calls[0][0])).not.toContain(config.apiKey);
    expect(String(fetchFn.mock.calls[1][0])).toBe("https://async.xinbao-ai.com/v1/tasks/batch-get");
    expect(fetchFn.mock.calls[1][1]?.method).toBe("POST");
    expect(fetchFn.mock.calls[1][1]?.headers).toMatchObject({ Authorization: `Bearer ${config.apiKey}` });
    expect(fetchFn.mock.calls[1][1]?.body).toBe(JSON.stringify({ ids: ["task-detail"] }));
    expect(String(fetchFn.mock.calls[1][0])).not.toContain(config.apiKey);
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/images/generations"))).toBe(false);
  });

  it("does not guess cloud task history endpoints for generic compatible providers", async () => {
    const fetchFn = vi.fn();
    const provider = new OpenAIImageProvider({
      ...config,
      baseUrl: "https://compatible.example",
    }, { fetchFn });

    await expect(provider.listTasks(new AbortController().signal)).rejects.toThrow("当前渠道不支持云端任务记录");
    await expect(provider.getTask("unknown-task", new AbortController().signal)).rejects.toThrow("当前渠道不支持云端任务记录");
    await expect(provider.batchGetTasks(["unknown-task"], new AbortController().signal)).rejects.toThrow("当前渠道不支持云端任务记录");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("marks a successful model-list response as credential verified", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      data: [{ id: "image-model", modalities: ["image"] }],
    }));
    const provider = new OpenAIImageProvider({
      ...config,
      baseUrl: "https://compatible.example",
    }, { fetchFn });
    await expect(provider.testConnection(new AbortController().signal)).resolves.toMatchObject({
      snapshot: {
        models: [expect.objectContaining({ id: "image-model", confirmedImage: true })],
        credentialVerified: true,
      },
      balance: { status: "error" },
    });
    expect(String(fetchFn.mock.calls[0][0])).toContain("/v1/models");
  });

  it("falls back to subscription and usage for Xinbao balance using the website point scale", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ hard_limit_usd: 2, access_until: 2_000_000_000 }))
      .mockResolvedValueOnce(json({ total_usage: 10 }));
    const provider = new OpenAIImageProvider(config, { fetchFn });

    await expect(provider.getBalance(new AbortController().signal)).resolves.toMatchObject({
      status: "available",
      total: 120,
      used: 6,
      remaining: 114,
      expiresAt: 2_000_000_000,
    });
    expect(String(fetchFn.mock.calls[0][0])).toBe(
      "https://xinbaoapi.dpdns.org/v1/dashboard/billing/credit_grants",
    );
    expect(fetchFn.mock.calls.map((call) => String(call[0])).join("\n"))
      .not.toContain(config.apiKey);
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: `Bearer ${config.apiKey}`,
    });
  });

  it("applies the Xinbao Banana display rate to credit-grant balances", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      total_granted: 1_500_000,
      total_used: 10_000,
      total_available: 1_490_000,
    }));
    const provider = new OpenAIImageProvider(config, { fetchFn });
    await expect(provider.getBalance(new AbortController().signal)).resolves.toMatchObject({
      status: "available",
      total: 180,
      used: 1.2,
      remaining: 178.8,
    });
  });

  it("uses credit_grants directly when a compatible provider supports it", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      total_granted: 12_000,
      total_used: 3_000,
      total_available: 9_000,
      expires_at: 2_000_000_000,
    }));
    const provider = new OpenAIImageProvider({
      ...config,
      baseUrl: "https://compatible.example",
    }, { fetchFn });
    await expect(provider.getBalance(new AbortController().signal)).resolves.toMatchObject({
      status: "available",
      total: 12_000,
      used: 3_000,
      remaining: 9_000,
    });
  });

  it("redacts the key from balance authentication errors", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      error: { message: `Bearer ${config.apiKey} rejected` },
    }, 401));
    const provider = new OpenAIImageProvider(config, { fetchFn });
    await expect(provider.getBalance(new AbortController().signal))
      .rejects.not.toThrow(config.apiKey);
  });

  it("does not report Xinbao connected when the account API rejects the key", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(json({ error: { message: "Invalid token" } }, 401));
    const provider = new OpenAIImageProvider(config, { fetchFn });
    await expect(provider.testConnection(new AbortController().signal))
      .rejects.toMatchObject({ name: "AuthenticationError" });
  });

  it("honours a larger Retry-After and survives a transient polling error", async () => {
    const delays: number[] = [];
    const running = json({ items: [{ id: "task-1", status: "running" }] });
    running.headers.set("retry-after", "20");
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ id: "task-1" }))
      .mockRejectedValueOnce(new TypeError("TLS reset"))
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(json({ items: [{
        id: "task-1",
        status: "succeeded",
        result: { data: [{ b64_json: btoa("done") }] },
      }] }));
    const provider = new OpenAIImageProvider(config, {
      fetchFn,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      maxPollAttempts: 4,
    });
    await expect(provider.generate({
      prompt: "test", model: "gpt-image-2-oai", n: 1, responseFormat: "url",
    }, new AbortController().signal)).resolves.toHaveLength(1);
    expect(delays).toEqual([10_000, 10_000, 20_000]);
    expect(fetchFn.mock.calls.filter(([url, init]) => (
      String(url).endsWith("/v1/images/generations") && init?.method === "POST"
    ))).toHaveLength(1);
  });

  it("does not leak the API key on authentication failure", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({
      error: { message: `Authorization ${["Bearer", config.apiKey].join(" ")} rejected` },
    }, 401));
    const provider = new OpenAIImageProvider(config, { fetchFn });

    await expect(provider.generate({
      prompt: "test", model: "gpt-image-2-oai", n: 1, responseFormat: "url",
    }, new AbortController().signal)).rejects.not.toThrow(/test-private-value/);
  });

  it("times out and honours cancellation", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ id: "task-1" }))
      .mockResolvedValue(json({ status: "running" }));
    const provider = new OpenAIImageProvider(config, {
      fetchFn,
      sleep: async () => undefined,
      maxPollAttempts: 2,
    });
    await expect(provider.generate({
      prompt: "test", model: "gpt-image-2-oai", n: 1, responseFormat: "url",
    }, new AbortController().signal)).rejects.toThrow(/超时/);

    const controller = new AbortController();
    controller.abort();
    await expect(provider.generate({
      prompt: "test", model: "gpt-image-2-oai", n: 1, responseFormat: "url",
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
