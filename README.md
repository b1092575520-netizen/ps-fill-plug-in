# Photoshop 生成填充紧凑面板

Photoshop UXP 生成图片插件。UXP 版本连接 OpenAI 兼容图片接口，支持文生图和整图图生图，下载真实生成结果，并以新文档或当前文档命名图层的方式非破坏性写入 Photoshop。浏览器版本只用于界面演示，不写入 Photoshop。

## 运行

```powershell
npm install
npm run demo
```

默认访问 `http://127.0.0.1:5173/`。若 5173 已占用，以 Vite 输出的实际端口为准。

## 云端图片库

云端记录支持按状态筛选、搜索模型/任务/提示词、按时间倒序分页查看。列表范围取决于服务商的最近 3 天记录接口。

点击“取回原图”会重新查询任务并下载已有结果，不重新提交生成请求。多张结果可以逐张查看；原图可以插入当前 Photoshop 文档、打开为新文档或保存到本地。当前文档以点击写入时的实际活动文档为准，插入命名图层，不覆盖原图。

下载和写入分别显示状态。写入失败后原图保留在当前详情中，再次点击写入无需重新生成或下载；离开详情会释放原图内存。过期或不可下载的云端结果会显示错误，并支持重试。刷新失败保留已有记录。

正式安装用户更新插件后重新启动 Photoshop 即可，无需通过调试器加载。下面的加载方式仅用于开发。

## 开发载入

运行 `npm run build:uxp`，然后在 UXP Developer Tool 中选择本项目的 `uxp/manifest.json` 载入。`uxp/` 是完整插件目录，包含 `manifest.json`、`index.html`、经典 IIFE 入口 `plugin.js` 和 `style.css`。重新构建后请在 UXP Developer Tool 中执行 Reload。

UXP 中填写 API Key 后：

- Key 只保存在 UXP `secureStorage`，清空输入框即可删除。
- 设置页会如实说明：Key 由 Photoshop UXP 安全存储保存，并会随请求发送到用户配置的 API Base URL；浏览器演示模式只驻留当前页面内存。
- UXP manifest 使用 `network.domains: "all"`，以支持用户配置的 HTTPS/回环 Base URL、参考图临时上传域名和供应商返回的动态 CDN；数组形式 `["all"]` 不会被 UXP 识别为全网权限。
- 默认 Xinbao Base URL 为 `https://async.xinbao-ai.com`。
- 连接测试使用不产生生成费用的 `POST /v1/tasks/batch-get`。该端点对无效 Key 也可能返回任务不存在，因此面板只显示“服务可达（Key 未验证）”，不会误报“凭据正常”；Xinbao Key 由首次真实生成响应验证。
- 文生图提交 `POST /v1/images/generations`，使用 `POST /v1/tasks/batch-get` 轮询；默认每 10 秒查询，并服从更大的 `Retry-After` / `next_poll_after_ms`。
- 支持同步兼容响应、Xinbao 异步任务响应、图片 URL 与 base64 结果；Xinbao 请求固定使用 `response_format=url`。
- 默认模型为 `gpt-image-2-oai`，并支持 `gpt-image-2`。两者都会自动补 `创建图片,` 前缀并按默认 2K 查表传 `size`；只有 OAI 模型传 `quality`。
- 本地参考图会先上传到 Litterbox 临时图床（24 小时），再按照最新文档作为 `image` URL 数组提交；请勿选择不允许发送给第三方的图片。

接口字段以 `G:\文档\WeChat Files\aaabbbccc778899\FileStorage\File\2026-07\AII开发文档.txt`（2026-07-27 16:05 修正版）为准。

## 原型边界

- 面板始终保持 280–360px 单栏定位，无模拟画布。
- 顶部状态灯显示真实连接测试状态。
- 支持两种模式：文生图，以及以当前可见画面为上下文的整图图生图。
- 参考区支持本地图片和通过 Photoshop 当前选区截取的参考图；重复图片会被忽略。
- 整图图生图自动加入一张当前画面，并固定写回任务启动时的原文档，不覆盖原图。
- 文生图提示词必填，真实接口支持自动比例、八种预设比例（含 21:9）及新建文档 / 当前文档输出目标；自定义比例只保留在演示界面，真实提交前会阻止。
- 主页面按生成工作流固定排序；无法生成时按钮以灰色直接显示原因，条件满足后才切换为紫色“生成 N 张”。
- 设置中心提供紧凑色块主题选择，悬停可查看主题说明。
- 提示词本提供内置模板、快速调用和当前提示词收藏。
- 上传、排队、轮询和下载均在 Photoshop 模态操作之外运行；面板显示阶段、进度、已用时间和取消按钮，生成期间可继续编辑或切换文档。
- 生成完成后切换到候选结果主视图，“返回修改”会保留当前提示词与生成参数。
- 当前文档输出会直接插入结果图层，不建立图层组；新建文档以首张候选建立正确尺寸画布，其余候选作为默认隐藏图层直接置入。图层名从提示词提炼为简短内容描述。
- 浏览器 Demo 明确标记为演示模式，生成与插入均为模拟。

## 验证

```powershell
npm test
npm run typecheck
npm run build:uxp
node scripts/check-protected-dirs.cjs
```
