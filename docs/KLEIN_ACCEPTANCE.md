# Klein 局部重绘验收记录

## 2026-07-29 蒙版快照修复复核

- ComfyUI 已从 `D:\ComfyUI-aki-li\ComfyUI` 启动并保持在 `http://127.0.0.1:8188`；`/system_stats` 返回 200，队列在本轮复核前为 0。
- 上轮 Photoshop 真机失败点为临时蒙版副本调用 `make user mask`，Photoshop 报“命令‘建立:’当前不可用”，因此未进入 ComfyUI 队列，也未写回原文档。
- 代码现改为：临时副本继承原始任意形状选区，选区外清为透明、选区内填白、取消选区后导出灰度 PNG；不再调用 `make user mask`。透明度载入时保留任意形状，避免退化为矩形。回归测试覆盖该失败路径。
- Adobe UXP CLI Validate 成功；本轮 Load 因 Photoshop 主机报告忙或处于模态状态超时，尚未取得修复后的真实 Photoshop 写回证据，不能把本节当作真机通过。

## 2026-07-28 单图真机冒烟

- 环境：`D:\ComfyUI-aki-li\ComfyUI`，ComfyUI `0.28.0`，RTX 2080 Ti 22GB，`http://127.0.0.1:8188`
- 素材：授权照片 `\\192.168.0.50\picture\1M9A3574.JPG`；验收目录 `D:\Klein验收样片` 当前不存在
- 选区：脸部下巴区域的任意形状椭圆选区；上下文裁切 `(2300,1300)-(5500,4400)`，模型输入 `768×736`
- 模型：`flux-2-klein-9b-fp8.safetensors` + `qwen_3_8b_fp8mixed.safetensors` + `flux2-vae.safetensors`
- 参数：4 steps、CFG 1、Euler、batch 1；空提示词语义由内置自然修复提示补足
- 结果：ComfyUI `/prompt` 返回 `93917569-8449-4b17-ade1-1afeaeca94f0`，PreviewImage 在 21.29 秒完成；结果位于临时目录，没有写入永久 `output`
- 原图安全：合成后选区外 539,808 像素中 475 个像素出现最大 1 灰度误差，其余完全一致；未发生整图替换
- 质量观察：生成内容和上下文人物结构连续，但下巴选区上缘仍可见轻微纹理/色调过渡，记录为“可用但需轻修”，不能据此晋级正式主力

## 2026-07-28 官方参考缩放链路 9B 复测

- 同一授权照片裁切和同一提示词；9B Distilled 使用 4 steps、CFG 1、Euler、seed `20260729`。
- ComfyUI 真实请求 `prompt_id=7d44aa54-748e-4106-bb7a-61c8eab6b419`，HTTP `/prompt` 成功，约 37.40 秒完成，输出仅写入临时 PreviewImage。
- 质量观察：人物身份、肤色、脸部结构和衣物连续，未出现 4B 首轮的粉色卡通伪影；9B 继续作为默认质量优先档位。仍需 Photoshop 任意形状选区写回复核和 20 张分类验收。

## 当前结论

本次证明本地服务、节点、模型清单、Klein 工作流、轮询和临时结果链路均可用；尚未完成 Photoshop UXP 实际写回和 20 张分类验收，状态保持“实验性”。

## 2026-07-28 4B 官方参考缩放链路复测

- 复测原因：此前 4B 直接将 `512×496` 参考图编码，输出出现粉色卡通下巴，判定不可用。
- 复测链路：`ImageScaleToTotalPixels(nearest-exact, 1MP)` → `GetImageSize` → 由实际尺寸驱动 `EmptyFlux2LatentImage` 与 `Flux2Scheduler`；参考图经同一缩放结果送入 `VAEEncode`，输出只保留 `PreviewImage`。
- 模型与参数：`flux-2-klein-base-4b-fp8.safetensors`、`qwen_3_4b.safetensors`、`flux2-vae.safetensors`；20 steps、CFG 5、Euler、seed `20260728`。
- ComfyUI：本次真实请求 `prompt_id=e576bc74-a734-4a5d-b9aa-598e1867406b`，HTTP `/prompt` 成功，PreviewImage 仅写入临时目录；实际输出为约 1MP 的完整参考编辑图。
- 质量观察：人物身份、肤色、脸部结构、衣物和背景连续，未再出现粉色卡通伪影；该复测证明官方参考缩放链路修复了此前的主要退化来源。仍需在 Photoshop 任意形状选区上完成最终写回复核，不能据此移除“实验性”。

## 2026-07-28 4B 真机对照

- 同一授权照片、同一下巴选区；4B Base 输入 `512×496`，20 steps、CFG 5、Euler
- `/prompt` 返回 `d01cc9c7-5533-4875-ba7a-eeb86d4d0183`，32.25 秒完成，结果仍为临时 PreviewImage
- 结果质量：选区内出现明显粉色卡通嘴/下巴，身份与肤色不保持，判定“不可用”
- 结论：4B 当前实现只证明请求链路可执行，不能作为生产档位；保持 9B 为默认，并在修正 4B 工作流前保留实验性

## 2026-07-29 写回安全修复记录

- 离线回归发现原实现把全不透明黑白 PNG 用 `transparencyEnum` 载入，任意形状可能退化为裁切矩形；现改为选区外透明、选区内白色，再由透明度恢复原始蒙版。
- 候选插入路径同步改为优先传递 `selectionSnapshot`，避免生成完成后丢失原始灰度蒙版。
- 本轮自动门禁：13 个测试文件、91 项测试、0 跳过；typecheck、UXP 构建与保护目录检查通过。
- Photoshop 当前处于未响应/主机忙状态，尚未取得透明蒙版修复后的真机描述符证据；不把离线回归或旧写回结果当作最终验收。

## 2026-07-29 安全门与轮询修复

- 写回前同时校验启动文档仍是当前 activeDocument；原文档仍打开但用户切换到另一份文档时直接拒绝，不创建临时文件。
- 局部模式的选区轮询只在非排队/生成状态运行；生成期间冻结启动快照，避免与 Photoshop modal 捕获和写回争用。

## 2026-07-29 ComfyUI 当前运行态单候选复核

- 使用现存临时参考图 `klein_local_cheek_context.png` 和 4B Base 官方参考缩放链路，`/prompt` 返回 `4ca5627c-dec0-4af4-8ace-f521be7c1412`。
- 20 steps、CFG 5、Euler、batch 1；`/history/{id}` 完成后通过 `/view` 下载 `ComfyUI_temp_uustj_00012_.png`，耗时 97.14 秒、PNG 2,209,820 bytes。
- 输出类型为 `PreviewImage`/`temp`，未写入永久 `output`；复核后 `/queue` 为 `queue_running=[]`、`queue_pending=[]`。
- 该次只证明 ComfyUI 当前端到端链路可用，不替代 Photoshop 任意形状写回复核，也不改变“实验性”状态。

## 当前验收矩阵

| 项目 | 当前证据 | 状态 |
| --- | --- | --- |
| 本地路由与心宝隔离 | `generationRouting` 证明局部只调用 `LocalInpaintProvider` | 通过 |
| Klein 工作流与取消 | 9B/4B 参数、PreviewImage、轮询失败、排队/运行中取消回归 | 通过 |
| 任意形状蒙版与坐标安全 | 离线 UXP Gateway 回归、文档切换/尺寸变化门禁 | 通过，待真机复核 |
| ComfyUI 当前运行态 | `/system_stats` 200、`/object_info` 3943 节点、4B `/prompt → /history → /view` | 通过 |
| Photoshop 透明蒙版写回 | 主机持续 `Responding=False`，最新 UXP 尚未 Load | 阻塞 |
| 四类 20 张晋级 | `D:\Klein验收样片` 不存在 | 阻塞，保持实验性 |
## 2026-07-29 用户接管正式验收

- Photoshop 当前进程已恢复响应；最新 UXP 产物经 Adobe UXP Developer Tools CLI Validate + Load 成功，会话 `8bcc208c-42b8-4c61-97e4-d13242a3cf81`。
- 本轮只加载插件，未触发生成、未写入当前未保存文档，也未创建或扫描 `D:\Klein验收样片`。
- 20 张正式质量验收由用户自行完成；在用户给出结果前，不把本地回归或单图 ComfyUI 证据冒充 18/20 真机晋级，Klein 继续标记“实验性”。
