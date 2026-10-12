> 来源：心宝提供的《AII开发文档.txt》（2026-07-27 16:05 修正版），2026-10-12 复制进项目。积分价格见 README「扣费」一节。

# 快捷生图 / 视频 API 参数整理（修正版）

> 本文档依据软件端实际实现（`src/main/services/xinbao-api.ts`、`src/preload/index.ts`、`src/shared/gpt-image-2-oai-size.ts`）核对修正。

---

## 一、模型识别与路由

通过 `isOpenAiAsyncImageModel` 判断：**模型 ID 以 `gpt-image-` 开头**走 OpenAI Async 通道，否则走 Gemini 通道。

```ts
// 实际实现
model.trim().toLowerCase().startsWith('gpt-image-')
```

所以 `gpt-image-2` 与 `gpt-image-2-oai` **都**走 OpenAI Async 通道（`/v1/images/generations`）。

---

## 二、gpt-image-2（标准通道）

端点：`POST https://async.xinbao-ai.com/v1/images/generations`

```json
{
  "model": "gpt-image-2",
  "prompt": "创建图片,<用户提示词>",
  "response_format": "url",
  "size": "2048x2048",
  "image": ["<url1>", "<url2>"]
}
```

| 参数 | 必填 | 说明 |
|---|---|---|
| model | ✅ | `gpt-image-2` |
| prompt | ✅ | 由代码自动加 `创建图片,` 前缀（见下方"提示词前缀"） |
| response_format | ✅ | 固定 `"url"` |
| **size** | ✅ | **会传**！由 `imageSize × aspectRatio` 查表得出（`ratio=auto` 时不查表、不传 size） |
| quality | ❌ | **不传**（仅 oai 传） |
| image | 否 | 参考图 URL 数组 |

> ⚠️ **修正**：原文档说 gpt-image-2「不传 size」是**错误**的。代码用 `isGptImage2SizeSupportedModel` 判定，它对 `gpt-image-2` 和 `gpt-image-2-oai` **都返回 true**，两者都会传 `size`。两者真正的区别是 **quality**：只有 `gpt-image-2-oai` 传 `quality`。

---

## 三、gpt-image-2-oai（OAI 通道）

端点：`POST https://async.xinbao-ai.com/v1/images/generations`

```json
{
  "model": "gpt-image-2-oai",
  "prompt": "创建图片,<用户提示词>",
  "response_format": "url",
  "size": "2048x2048",
  "quality": "high",
  "image": ["<url1>"]
}
```

| 参数 | 必填 | 说明 |
|---|---|---|
| model | ✅ | `gpt-image-2-oai` |
| prompt | ✅ | 同上，自动加 `创建图片,` 前缀 |
| response_format | ✅ | 固定 `"url"` |
| size | ✅ | `"WxH"`；`ratio=auto` 时传 `"auto"` |
| **quality** | ✅ | `low` / `medium` / `high`，默认 `high` |
| image | 否 | 参考图 URL 数组 |

### 提示词前缀（两渠道通用）

`normalizeOpenAiImagePrompt`：IPC 层传入的 prompt **不含**前缀，API 层自动补：
- 空 prompt → `创建图片,`
- 已以 `创建图片,` 开头 → 原样
- 否则 → `创建图片,` + 原文

### size 查表（`getGptImage2OaiSizeParam`）

| imageSize \ ratio | 1:1 | 2:3 | 3:2 | 4:3 | 3:4 | 16:9 | 9:16 | **21:9** |
|---|---|---|---|---|---|---|---|---|
| 1K | 1024×1024 | 1024×1536 | 1536×1024 | 1024×768 | 768×1024 | 1280×720 | 720×1280 | **1344×576** |
| 2K（默认） | 2048×2048 | 1360×2048 | 2048×1360 | 2048×1536 | 1536×2048 | 2048×1152 | 1152×2048 | **2400×1024** |
| 4K | 2880×2880 | 2336×3504 | 3504×2336 | 3264×2448 | 2448×3264 | 3840×2160 | 2160×3840 | **3840×1648** |

> ⚠️ **修正**：原文档缺了 **21:9** 这一列。实际代码支持 8 种比例：`1:1 / 3:2 / 2:3 / 4:3 / 3:4 / 16:9 / 9:16 / 21:9`。
> - `ratio` 不在表内时回退到 `1:1`；`imageSize` 不在 `1K/2K/4K` 时回退到 `2K`。
> - 仅 `ratio=auto` 时 size 传 `"auto"`。

---

## 四、两个 GPT 通道对比（修正后）

| 特性 | gpt-image-2 | gpt-image-2-oai |
|---|---|---|
| 走哪条通道 | OpenAI Async（`/v1/images/generations`） | OpenAI Async（同左） |
| **size 参数** | **传**（WxH 字符串，auto 时不传） | **传**（WxH，auto 时传 `"auto"`） |
| **quality 参数** | **不传** | **传**（默认 high） |
| 支持 auto 比例 | 否（ratio=auto 时不传 size） | 是（传 `size:"auto"`） |

> 两渠道**真正的区别是 quality**（只有 oai 传），而非 size。size 两者都传。

---

## 五、IPC 层调用参数（图片，两渠道共用）

```ts
window.api.quickgenGenerateImage({
  localTaskId: string,          // 必填
  model: string,                // "gpt-image-2" | "gpt-image-2-oai" | gemini 各款
  prompt: string,               // IPC 层不加前缀，API 层加
  imageUrls?: string[],         // 参考图 URL
  aspectRatio?: string,         // "1:1" | "16:9" | "auto" 等
  imageSize?: string,           // "1K" | "2K" | "4K"，默认 "2K"
  imageQuality?: 'low' | 'medium' | 'high'  // 仅 gpt-image-2-oai 生效
})
```

批量：`window.api.quickgenGenerateImageBatch({ tasks: [...上述结构] })`。

---

## 六、全能图片Pro → Gemini 通道

端点：`POST https://async.xinbao-ai.com/v1beta/models/{model}:generateContent`

Headers：
```
Authorization: Bearer {api_key}
Content-Type: application/json
```

Body：
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        { "text": "你的提示词" },
        {
          "inlineData": {
            "mimeType": "image/jpeg",
            "data": "<图片base64或URL>"
          }
        }
      ]
    }
  ],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": {
      "output": "url",
      "aspectRatio": "1:1",
      "imageSize": "2K"
    }
  }
}
```

说明（与代码一致）：
- `parts` 中先放 `text`，再逐个放参考图 `inlineData`（`mimeType` 由 URL 后缀推断，`data` 直接放 URL）。
- `imageConfig.output` 固定 `"url"`；`aspectRatio` 有值才加；`imageSize` 默认 `"2K"`。
- Gemini 通道**不加** `创建图片,` 前缀（该前缀仅 OpenAI 通道用）。

model 取值：

| 模型 | model 值 |
|---|---|
| 全能图片Pro Vip | gemini-3-pro-image-preview-vip |
| 全能图片Pro Svip | gemini-3-pro-image-preview-svip |
| 全能图片Pro（普通渠道） | gemini-3-pro-image-preview |
| 全能图片3.1 | gemini-3.1-flash-image-preview |
| 全能图片2.5 | gemini-2.5-flash-image |

Response（提交成功）：
```json
{ "id": "task-xxx", "status": "accepted", "polling_url": "...", "content_url": "..." }
```

---

## 七、轮询任务结果（两渠道通用）

```
POST https://async.xinbao-ai.com/v1/tasks/batch-get
Body: { "ids": ["task-xxx"] }
```

---

## 八、视频（Seedance）IPC 调用

```ts
await window.api.quickgenGenerateVideo({
  localTaskId: 'task-001',         // 必填
  model: 'seedance-2.0',           // 或 'seedance-2.0-fast'
  prompt: '午夜霓虹下的未来城市',
  aspectRatio: '16:9',             // 16:9、9:16 等
  seedanceMode: 'multimodal',      // 'multimodal' | 'keyframes' | 'first_last'
  seedResolution: '720p',          // '480p' | '720p'
  seedancePersonImageUrls: ['https://example.com/person.jpg'],
  seedanceGenericImageUrls: ['https://example.com/generic.jpg'],
  referenceVideoUrls: ['https://example.com/ref.mp4'],
  referenceAudioUrls: ['https://example.com/ref.wav'],
  generateAudio: true,
  duration: 10
})
```

### 关键参数

| 参数 | 说明 |
|---|---|
| localTaskId | 本地任务 ID，必填 |
| model | `seedance-2.0` 或 `seedance-2.0-fast` |
| prompt | 生成文本 |
| aspectRatio | 如 16:9、9:16 |
| seedanceMode | `multimodal`（多模态：参考图/视频混合）/ `keyframes`（首尾帧）/ `first_last`（首尾帧别名，实际枚举值就是 `first_last`） |
| seedResolution | `480p` 或 `720p` |
| generateAudio | 是否生成音频 |
| duration | 时长（秒） |

> ⚠️ **修正**：`seedanceMode` 的枚举值是 `'multimodal' | 'keyframes' | 'first_last'` 三个（preload 里就是这三个字面量）。原文档把 `first_last` 写成「keyframes 也是兼容别名」并不准确——它是一个**独立的合法枚举值**，不是别名。

### 参考素材传法

**结构化参考图（推荐）**：
- `seedancePersonImageUrls`：真人参考图
- `seedanceGenericImageUrls`：普通参考图
- 也可只传 `imageUrls` / `imageUrl`，底层用 `seedanceSubjectType`（`'generic' | 'person'`）标记

**参考视频 / 音频**：
- 复数：`referenceVideoUrls`、`referenceAudioUrls`、`seedancePersonReferenceVideoUrls`
- 单数（兼容）：`referenceVideoUrl`、`referenceAudioUrl`

### 底层如何组装（旧 Seedance）

主进程把参数转成一个 content 数组：
- 图片 → `image_url`
- 参考视频 → `video_url`
- 参考音频 → `audio_url`
- 文本 → `text`

上层只要把参数传好，底层自动构建请求体。

### 其他调用注意

- **不要**传 New API 相关参数：`seedanceFiles`、`seedanceAssetUris`、`seedanceNewApiResolution`（这些是 legacy/其他通道的字段，普通调用无需传）。
- `model` 直接传 `seedance-2.0` 或 `seedance-2.0-fast`。
- `seedResolution` 仍传 `480p` / `720p`。

---

## 修正点汇总

| # | 原文档 | 实际代码 |
|---|---|---|
| 1 | gpt-image-2 **不传 size** | gpt-image-2 **会传 size**；两渠道区别在 **quality**（仅 oai 传） |
| 2 | size 表缺 **21:9** 列 | 支持 21:9（1K=1344×576、2K=2400×1024、4K=3840×1648） |
| 3 | 4K 21:9 未列 | 4K 21:9 = 3840×1648 |
| 4 | seedanceMode 只提 multimodal/keyframes，把 first_last 当别名 | `first_last` 是独立合法枚举值 |
| 5 | Gemini Response 只列 id/status/polling_url | 实际还可能含 `content_url` |