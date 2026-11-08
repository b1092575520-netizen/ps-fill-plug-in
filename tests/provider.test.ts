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
  it("recovers the selected cloud result from fresh task detail without a generation POST or CDN credentials", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ id: "saved-task", status: "succeeded", result: { data: [
      { url: "https://cdn.example/first.png" }, { url: "https://cdn.example/second.png" },
    ] } })).mockResolvedValueOnce(new Response(new Uint8Array([2]), { headers: { "content-type": "image/png" } }));
    const provider = new OpenAIImageProvider(config, { fetchFn });
    const result = await provider.recoverTaskImage("saved-task", 1, new AbortController().signal);
    expect(result.asset.bytes).toEqual(new Uint8Array([2]));
    expect(result.task.resultUrls).toHaveLength(2);
    expect(fetchFn.mock.calls[1][0]).toBe("https://cdn.example/second.png");
    expect(fetchFn.mock.calls[1][1]?.headers).toBeUndefined();
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/images/generations"))).toBe(false);
  });

  it("never downloads unsuccessful tasks or nonexistent result slots", async () => {
    for (const status of ["running", "failed", "succeeded"]) {
      const fetchFn = vi.fn().mockResolvedValueOnce(json({ id: "task", status, result: { data: [{ url: "https://cdn.example/a.png" }] } }));
      const provider = new OpenAIImageProvider(config, { fetchFn });
      await expect(provider.recoverTaskImage("task", 3, new AbortController().signal)).rejects.toThrow();
      expect(fetchFn).toHaveBeenCalledOnce();
    }
  });
  it.each(["connection", "body", "server"])("recovers a failed result download (%s) without generating again", async (stage) => {
    const url = "https://cdn.example/result.png";
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ data: [{ url }] }));
    if (stage === "connection") fetchFn.mockRejectedValueOnce(new TypeError("Network request failed"));
    else if (stage === "body") fetchFn.mockResolvedValueOnce({
      ok: true, status: 200, headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => { throw new TypeError("Network request failed"); },
    });
    else fetchFn.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetchFn.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }));
    const sleep = vi.fn(async () => undefined);
    const provider = new OpenAIImageProvider(config, { fetchFn, sleep });
    const result = await provider.generate({ prompt: "test", model: config.model, n: 1, responseFormat: "url" }, new AbortController().signal);
    expect(result[0].bytes).toEqual(new Uint8Array([1, 2]));
    expect(fetchFn.mock.calls.filter(([target]) => String(target).includes("/images/generations"))).toHaveLength(1);
    expect(fetchFn.mock.calls.slice(1).map(([target]) => target)).toEqual([url, url]);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("bounds download retries and reports cloud success separately", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ data: [{ url: "https://cdn.example/result.png" }] }))
      .mockRejectedValue(new TypeError("Network request failed"));
    const provider = new OpenAIImageProvider(config, { fetchFn, sleep: async () => undefined });
    await expect(provider.generate({ prompt: "test", model: config.model, n: 1, responseFormat: "url" }, new AbortController().signal))
      .rejects.toThrow("云端图片已生成，但下载失败");
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("stops download retries when cancelled during backoff", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ data: [{ url: "https://cdn.example/result.png" }] }))
      .mockRejectedValue(new TypeError("Network request failed"));
    const provider = new OpenAIImageProvider(config, { fetchFn, sleep: async () => { controller.abort(); } });
    await expect(provider.generate({ prompt: "test", model: config.model, n: 1, responseFormat: "url" }, controller.signal)).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

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

  it("accepts the official dashboard envelope and numeric task timestamps/ids", async () => {
    const createdAt = Math.floor((Date.now() - 2_000) / 1000);
    const fetchFn = vi.fn().mockResolvedValueOnce(json({
      object: "list",
      days: 3,
      items: [{
        id: 12345,
        model: "gpt-image-2-oai",
        status: "succeeded",
        created_at: String(createdAt),
        finished_at: createdAt + 1,
        result: { data: [{ url: "https://cdn.example/generated.png" }] },
      }],
    }));
    const provider = new OpenAIImageProvider(config, { fetchFn });

    await expect(provider.listTasks(new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({
        taskId: "12345",
        createdAt: createdAt * 1000,
        completedAt: (createdAt + 1) * 1000,
        thumbnailUrl: "https://cdn.example/generated.png",
      }),
    ]);
  });

  it("normalizes microsecond cloud timestamps before the three-day filter", async () => {
    const createdAt = Date.now() - 3_000;
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ items: [{
      id: "microseconds",
      status: "succeeded",
      created_at: createdAt * 1000,
    }] }));
    const provider = new OpenAIImageProvider(config, { fetchFn });

    await expect(provider.listTasks(new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({ taskId: "microseconds", createdAt }),
    ]);
  });

  it("does not turn a successful but unknown cloud response into an empty history", async () => {
    const provider = new OpenAIImageProvider(config, {
      fetchFn: vi.fn().mockResolvedValueOnce(json({ object: "list", result: "temporarily unavailable" })),
    });

    await expect(provider.listTasks(new AbortController().signal))
      .rejects.toThrow("云端记录返回格式无法识别");
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

  it("submits another document while the first document's paid fetch is still waiting", async () => {
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
    }, new AbortController().signal)).resolves.toHaveLength(1);
    expect(secondFetch).toHaveBeenCalledOnce();
    expect(coordinator.isBusy("doc-a")).toBe(true);
    expect(coordinator.isBusy("doc-b")).toBe(false);

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
    }, new AbortController().signal)).rejects.toThrow("心宝返回的文件不是图片");
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

  it.each(["success", " SUCCESS ", "succeeded", "completed"])(
    "accepts the provider success status alias %s",
    async (status) => {
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(json({ id: "task-success-alias" }))
        .mockResolvedValueOnce(json({ items: [{
          id: "task-success-alias",
          status,
          result: { data: [{ b64_json: btoa("done") }] },
        }] }));
      const provider = new OpenAIImageProvider(config, {
        fetchFn,
        sleep: async () => undefined,
        maxPollAttempts: 1,
      });

      await expect(provider.generate({
        prompt: "test", model: "gpt-image-2-oai", n: 1, responseFormat: "url",
      }, new AbortController().signal)).resolves.toHaveLength(1);
    },
  );

  it.each(["error", " ERROR ", "failed", "cancelled", "not_found", "uncertain"])(
    "rejects the provider failure status alias %s",
    async (status) => {
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(json({ id: "task-failure-alias" }))
        .mockResolvedValueOnce(json({ items: [{ id: "task-failure-alias", status }] }));
      const provider = new OpenAIImageProvider(config, {
        fetchFn,
        sleep: async () => undefined,
        maxPollAttempts: 1,
      });

      await expect(provider.generate({
        prompt: "test", model: "gpt-image-2-oai", n: 1, responseFormat: "url",
      }, new AbortController().signal)).rejects.toThrow();
    },
  );

  it("releases the account when Xinbao reports the task outcome as uncertain", async () => {
    const coordinator = new RemoteRequestCoordinator({ load: async () => [], save: async () => undefined });
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ id: "task-uncertain" }))
      .mockResolvedValueOnce(json({ items: [{ id: "task-uncertain", status: "uncertain" }] }));
    const provider = new OpenAIImageProvider(config, {
      fetchFn, sleep: async () => undefined, maxPollAttempts: 1, requestCoordinator: coordinator,
    });

    await expect(provider.generate({
      prompt: "test", model: "gpt-image-2-oai", n: 1, responseFormat: "url",
      audit: {
        localRequestId: "request-uncertain", documentId: "doc", mode: "text" as const,
        submittedAt: Date.now(), promptHash: "sha256:u",
      },
    }, new AbortController().signal)).rejects.toThrow("云端记录核对");
    expect(coordinator.snapshot()[0]).toMatchObject({ providerTaskId: "task-uncertain", status: "unknown" });
    expect(coordinator.isBusy()).toBe(false);
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
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Bearer /),
      Accept: "application/json",
    });
    expect(String(fetchFn.mock.calls[0][0])).not.toContain(config.apiKey);
    expect(fetchFn.mock.calls[0][1]?.body).toBeUndefined();
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/images/generations"))).toBe(false);
  });

  it("returns an empty cloud record list and reports 401 or 429 clearly", async () => {
    const empty = new OpenAIImageProvider(config, { fetchFn: vi.fn(async () => json({ items: [] })) });
    await expect(empty.listTasks(new AbortController().signal)).resolves.toEqual([]);

    const unauthorized = new OpenAIImageProvider(config, { fetchFn: vi.fn(async () => json({}, 401)) });
    await expect(unauthorized.listTasks(new AbortController().signal)).rejects.toThrow("云端记录鉴权失败（401）");

    const forbidden = new OpenAIImageProvider(config, { fetchFn: vi.fn(async () => json({}, 403)) });
    await expect(forbidden.listTasks(new AbortController().signal)).rejects.toThrow("云端记录鉴权失败（403）");

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

  it("keeps waiting through busy or failing status checks without a second paid POST", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ id: "task-1" }))
      .mockResolvedValueOnce(json({ error: { message: "busy" } }, 503))
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({ items: [{
        id: "task-1",
        status: "succeeded",
        result: { data: [{ b64_json: btoa("done") }] },
      }] }));
    const provider = new OpenAIImageProvider(config, { fetchFn, sleep: async () => undefined, maxPollAttempts: 4 });
    await expect(provider.generate({
      prompt: "test", model: "gpt-image-2-oai", n: 1, responseFormat: "url",
    }, new AbortController().signal)).resolves.toHaveLength(1);
    expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/v1/images/generations"))).toHaveLength(1);
  });

  it("still stops on an authentication failure while polling", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ id: "task-1" }))
      .mockResolvedValueOnce(json({}, 401));
    const provider = new OpenAIImageProvider(config, { fetchFn, sleep: async () => undefined, maxPollAttempts: 4 });
    await expect(provider.generate({
      prompt: "test", model: "gpt-image-2-oai", n: 1, responseFormat: "url",
    }, new AbortController().signal)).rejects.toThrow("鉴权失败（401）");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("waits about ten minutes for Xinbao before handing the task to cloud records", async () => {
    const delays: number[] = [];
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ id: "task-1" }))
      .mockResolvedValue(json({ items: [{ id: "task-1", status: "running" }] }));
    const provider = new OpenAIImageProvider(config, { fetchFn, sleep: async (ms) => { delays.push(ms); } });
    await expect(provider.generate({
      prompt: "test", model: "gpt-image-2-oai", n: 1, responseFormat: "url",
    }, new AbortController().signal)).rejects.toThrow(/超时.*云端记录/);
    expect(delays.reduce((total, ms) => total + ms, 0)).toBe(600_000);
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
