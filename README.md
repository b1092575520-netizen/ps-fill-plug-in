# 生成填充（Photoshop 生图插件）

Photoshop 侧边栏面板，用心宝 AI（gpt-image-2 系列）生图，结果以新图层或新文档放进 Photoshop，不覆盖原图。和 `D:\software` 下的小程序、排版插件无关。

## 功能

- **文生图**：写提示词出图，8 种比例（含 21:9）或自动比例，1K/2K/4K，一次 1～4 张；结果放进当前文档新图层，或新建文档。
- **图生图**：以当前可见画面为底图出图，结果写回生成时的原文档。
- **参考图**：本地图片或 Photoshop 当前选区截图，最多 9 张（图生图会自动占 1 张）。
- **多张候选**：点击候选可在 Photoshop 里实时预览，确认后只保留选中的一层。
- **云端记录**：最近 3 天在心宝出过的图，可重新取回原图，插入当前文档、开新文档或存到电脑，不会重复扣费。
- 提示词本、历史记录、配色主题、生成设置记忆。

## 扣费与防重复扣费

- 价格（2026-10-12 心宝积分表，1 元 = 60 积分）：全能图像 G-2.0 OAI（`gpt-image-2-oai`）每张 12 积分，1–4K 同价；全能图像 G-2.0（`gpt-image-2`）每张 6 积分，1–2K 同价。生成按钮会显示预计积分，价格在 `src/backend/pointPricing.ts`，心宝调价时改这里。
- 同一时间只跑一个付费任务。任务提交后：
  - 拿到任务编号的：插件等最多约 10 分钟；查询中途服务器报错会继续等。等不到或你点了取消，插件转到后台每 20 秒问一次心宝，出图后提示你去云端记录取回，并自动解锁（最多锁 20 分钟）。
  - 提交后没收到任何回应的（断网、服务器报错、Photoshop 崩溃）：无法确认是否扣费，锁 3 分钟并提示先去云端记录看，3 分钟后自动解锁。
- 点「取消」只是不再等待。任务已经提交给心宝的，心宝仍会出图并扣分，提示里会说明。
- 记账文件在 `%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\27\External\com.codex.generative-fill\PluginData\remote-request-ledger.v1.json`，只存任务编号和提示词哈希，保留 3 天。

## 隐私

- 心宝只接受图片网址，所以参考图（包括图生图时的当前画面）会先上传到 Litterbox 临时图床，**1 小时后自动删除**；上传失败就直接报错，不会改传其他网站。客人照片介意外传时不要用参考图功能。
- API Key 存在 Photoshop UXP 安全存储里，随请求发给心宝：生图走 `async.xinbao-ai.com`，云端记录走 `task.xinbao-ai.com`，余额查询走 `xinbaoapi.dpdns.org`。

## 安装与更新

日常使用的插件装在 `C:\Program Files\Common Files\Adobe\UXP\Plugins\External\com.codex.generative-fill_0.1.0`。改完代码、提交 git 之后：

```powershell
npm run deploy
```

它会构建、检查，把当前安装的版本备份到 `backups\`（不进 git），再覆盖安装目录，并写入 `build-info.txt` 记录装的是哪个提交。**重启 Photoshop 后生效。** 回退：把 `backups\` 里对应文件夹的文件拷回安装目录，重启 Photoshop。

开发调试时也可以运行 `npm run build:uxp`，在 UXP Developer Tool 里加载 `uxp\manifest.json`。

## 开发

```powershell
npm install
npm run demo        # 浏览器演示，http://127.0.0.1:5173/，生成和写入都是模拟的
npm test
npm run typecheck
npm run build:uxp   # 生成 uxp\ 目录（plugin.js、style.css 等）
```

- 插件源文件：`src/`；UXP 外壳（`index.html`、`manifest.json`、`icon.png`）在 `uxp-static/`，构建时复制进 `uxp/`。
- 心宝接口说明：[docs/xinbao-api.md](docs/xinbao-api.md)。
- 2026-07 至 2026-08 由 Codex 开发时的过程记录已归档到 `docs/history/`，只作追溯，内容可能已过时。

## 已知限制

- 不能只改选区：图生图是整张重画再盖一层，选区外也会有细微变化。想只换一块，可以给结果图层加蒙版，只露出要换的地方。
  2026-10-12 实测过：预设比例下出图偏移不超过 2 像素，做「选区自动蒙版」是可行的，但日常改图已改用 Adobe 创成式填充，暂不开发。
- 图生图会把原图比例凑成最接近的预设比例，5:7、4:5 等比例的结果放回时会错开几十像素，需要手动对齐。
- 不能排队，一次只能跑一个任务。
- 版本号仍是 0.1.0：在原安装目录上覆盖更新，没有走 Creative Cloud 的版本升级。
