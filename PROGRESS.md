# 开工回执（2026-08-18）
- 目标：恢复 `D:\ps fill plug-in`，最终仅交付正式目录。
- 基线：以 `D:\ps fill plug-in-replay-phase4-archive` 为主，phase2 archive 做回归对照。
- 顺序：边界核验 → C 盘临时副本 → manifest/结构 → 259 项测试 → 构建/校验 → 正式目录整合。
- 最大风险：phase4 当前 18 项失败、缺少 `uxp-static/manifest.json`，且 Photoshop 真机生命周期仍需单独验收。
- 当前基线：phase4 typecheck 通过；npm test 259 项中 18 项失败，失败集中在 manifest 与 UXP CSS 回归。
- 安全边界：不操作 Photoshop，不读取 API Key，不修改 D 盘恢复副本，不删除任何恢复目录。

## 2026-08-18 恢复阶段结果
- 已完成：C 盘临时副本建立；补齐 `uxp-static/manifest.json`；修复 Klein 4B 原生选区路径和历史 UXP CSS 回归。
- 结构补齐：从 phase2/phase4 内容哈希一致的依赖锁定文件恢复 `package-lock.json`（SHA256 `21824dc9...feb64`），已同步正式目录并由 `npm ci` 安装 103 个依赖包。
- 验证：`npm test` 28 文件/259 测试/0 跳过；`npm run typecheck` 退出 0；`npm run build:uxp` 与 `npm run verify:uxp` 退出 0。
- 产物：`uxp/manifest.json` 672 bytes、`plugin.js` 321549 bytes、`style.css` 35749 bytes，包含经典 IIFE 入口和 V5 权限。
- 阻塞：`node scripts/check-protected-dirs.cjs` 所需两套保护目录缺失；其余正式离线门禁均已通过，详见 `BLOCKED.md`。
- Git：正式目录已初始化 `main`，恢复快照提交 `6c23cb4`，工作树当前干净。
- 下一步：补齐/裁决保护目录摘要后重跑该脚本；Photoshop 真机验收仍未执行，不宣称真机完成。

# 后端与 Photoshop 接入进度

## 2026-08-15 当前续验收记录
- 续跑门禁：`npm test` 为 28 文件/259 测试全绿；`npm run typecheck`、`git diff --check`、`node scripts/check-protected-dirs.cjs` 均退出 0；skip/todo/only 无匹配。
- `npm run build:uxp` 全绿：53 modules，`style.css 41.28 kB`、`plugin.js 321.86 kB`，UXP verify 通过；测试数高于 252 基线。
- 源码审计确认生产已无 `CenteredSelect`，下拉为共享状态的真实 button/listbox；云端缓存包含首屏加载、详情补查、并发限制、重试和 Blob revoke。
- 本次续验收未控制桌面：Photoshop 当前是用户另一份带未保存标记的文档，UDT 已退出；不抢前台、不切文档、不以旧截图冒充最新反向点击或图片 DOM 证据。
- 已清理本轮 UXP 调试残留 `uxp/.uxprc`；保护目录和既有脏工作保持不变。

## 2026-08-15 下拉菜单布局修复
- 用户截图红灯：菜单使用普通文档流，打开输出位置、模型或分辨率时会把后续按钮整体下推；触发器还显示无用 `⌄`。
- 修复：`.uxp-dropdown__list` 改为触发器下方绝对定位覆盖，触发器改为无箭头列的居中 flex；删除箭头节点与样式。
- 红→绿：更新契约后 `tests/UxpDropdown.test.tsx` 与 `tests/uiWorkflow.test.tsx` 为 64/64；完整门禁为 28 文件/259 测试、53 modules 构建、typecheck、diff check、保护目录全绿，skip/todo/only=0。

## 2026-08-15 UXP 下拉彻底替换与云端图片闭环
- 目标：废除 `CenteredSelect` 原生 select/假文本叠层，统一为 DOM 按钮+listbox；云端同时执行历史 list 与必要 batch 恢复，首屏自动显示任务卡和图片。
- 顺序：下拉交互红测→`UxpDropdown` 与全部调用点→list+batch 合并红测→首屏12张/并发3图片闭环→最多三轮完整门禁与零费用 Photoshop 真机。
- 最大风险：UXP 的焦点与文档级外部点击行为、供应商时间字段漂移、图片下载/详情请求在页面关闭或身份切换时的取消与 Blob 释放。
- 任务0与整改书一致：`npm test` 为27文件/252测试；typecheck、diff check、保护目录检查退出0，skip/todo/only无匹配。
- 保护目录仍为35文件/`aa333f4b...e487`、4808文件/`d83e11a3...b6d`；既有脏工作全部保留，本轮只改白名单。
- 用户截图确认旧原生下拉闭合态仍左偏且第一次切换只出现焦点；本轮不再调整该方案 CSS，也不使用二次 click、定时器或透明遮罩。
- 首组红灯：定向3文件中 `UxpDropdown` 因模块不存在整套失败；list+batch 测试收到 `listTasks=0`；自动图片测试等待超时，合计 `2 failed | 8 passed` 加1个失败 suite，准确复现三项旧行为。
- 下拉控件首个绿灯：新增共享 `openId` 的按钮+listbox组件，覆盖A→B→A一次点击、选择、外部关闭、Esc/方向键/Enter和禁用态；定向2/2、typecheck通过，源码中 `CenteredSelect`/透明文字旧模式为0。
- 云端合并与时间绿灯：历史list始终请求，存在未完成账本时并行batch，按taskId合并并优先终态/完整URL；未知时间保留在末尾，兼容camelCase与下划线字段。旧标准2项红后同组 `2 files / 26 tests` 全绿，typecheck通过。
- 云端图片闭环绿灯：旧实现自动调用0次、13卡全显的3项红后，现为首屏12条、必要详情自动查、队列并发上限3、加载/图片/错误重试三态及加载更多；UI定向3/3、Hook+真实集成11/11、typecheck通过，生成端点断言仍为0。
- 第1轮完整门禁通过：`28 files / 258 tests`、skip/todo/only=0，typecheck与diff check退出0；UXP构建53 modules、`style.css 41.32 kB`、`plugin.js 321.86 kB`且verify通过；保护哈希不变。

## 2026-08-15 云端记录、UXP 下拉框与设置页治理
- 目标：消除云端记录 `idle` 白屏、全部可见下拉框左偏/不可点击风险，并按四组重排设置页；不改 API、计费、生成、写回、候选或 ComfyUI 业务链。
- 顺序：状态机红测与 `useCloudRecords` → 单个输出下拉真机原型 → 全部下拉复用 → 四组设置页与 `useConnectionSettings` → 最多三轮完整门禁及零费用 UXP 真机。
- 最大风险：UXP 原生 select 的文字对齐与点击可靠性冲突；必须保持可见原生控件，不使用透明覆盖，并以真实 UXP 点击/键盘/焦点证据裁决。
- 任务 0 与任务书一致：25 文件/246 测试、skip/todo/only=0；typecheck、diff check、保护目录检查退出 0，保护哈希仍为 `aa333f4b...e487` / `d83e11a3...b6d`。
- 关键行数：`usePrototypeState.ts=2204`、`Shared.tsx=989`、`styles.css=1037`；工作树既有大量未提交修改，本轮仅触碰白名单并保留其余状态。
- 三张真机截图已核对：云端页仅标题无状态内容；主界面 select 文字靠左；设置页未分四组、刷新/测试/恢复默认层级过重且 Klein 长说明拥挤。
- 云端状态机与 `useCloudRecords` 完成：`idle` 白屏红测先为 1/58 失败后恢复 58/58；Hook 模块缺失红灯后 2/2 通过，覆盖打开即刷新、身份切换中止旧请求、迟到结果丢弃、错误与关闭清理；接线定向回归 3 文件/67 测试及 typecheck 通过，既有任务恢复链生成 POST 仍为 0。
- UXP 下拉自动化契约完成：旧 CSS 隐藏居中值层的红测为 1 failed/57 skipped；改为 `opacity:1` 的真实原生 select 承担点击、键盘、焦点和禁用，居中文字层 `pointer-events:none` 后定向 1/1、UI 59/59 通过，禁止透明 select 的反向断言保留。
- 设置页完成四组重排：旧 DOM 红测为 2 failed/57 skipped；现为“API 连接、模型能力、本地重绘、外观”，唯一主操作为保存，刷新/测试同一行，9B 静态显示、主题显示当前名称，Klein 说明可换行；UI 59/59 通过。
- `useConnectionSettings` 完成：模块缺失红灯后 Hook 2/2 通过，覆盖 Provider 请求取消/身份重置与安全存储写入；接入主 Controller 后 Provider 状态、两个 Hook、主集成与 UI 共 5 文件/72 测试通过，typecheck 退出 0。
- 第 1、2 轮完整离线门禁均通过：最终 `npm test` 为 27 文件/251 测试，typecheck 退出 0；`build:uxp` 为 52 modules、`style.css 40.34 kB`、`plugin.js 318.42 kB` 且 verify 通过；diff check 仅 CRLF 提示，skip/todo/only 为 0，保护哈希仍为 `aa333f4b...e487` / `d83e11a3...b6d`。
- 最新构建在 Photoshop 27.8.0 真实 Validate + Load 成功（最终会话 `71a27837-b478-44ab-aa4d-0a543bb33f4d`）；Photoshop PID 20132 保持 `Responding=True`，当前带 `*` 用户文档标题未变，未生成、未写入、未保存或切换文档。
- 桌面捕获恢复后完成真实鼠标复核：插入位置、比例、模型、分辨率和质量下拉均能打开；数量以真实 `+/-` 完成 `1→2→1` 并恢复原值。501px 高度下最后一行需滚动才可达，不是透明层或禁用态拦截。
- 设置页短面板缺陷完成红→绿：首次滚轮不可达后新增契约为 `1 failed | 59 skipped`；建立独立滚动区后真机又发现四组被 Flex 压缩重叠，第二次红灯同为 `1 failed | 59 skipped`；禁止组收缩后定向通过且 UI `60/60`。280px 真机顶部与滚动底部均显示四组完整、无截断/重叠。
- UXP 真机交互补证完成：输出位置下拉可由鼠标打开，聚焦边框可见，`Alt+↓` 可打开；局部重绘 9B 禁用选择框用鼠标与 `Alt+↓` 均不能打开。独立 `OWL.Dock` 宿主临时调到 320/360px 后均无截断、重叠或横向滚动，并已精确恢复原 `282×472`。
- 本构建云端网络补证完成：清空 Network 后只打开一次云端记录，唯一任务历史请求为 `GET https://task.xinbao-ai.com/api/v1/tasks?limit=100`，约 834ms 后返回列表；同期只有余额 GET，没有 `/v1/images/generations`，生成 POST 数为 0。未记录或写入 Authorization 值。
- 第 3 轮最终完整门禁通过：`npm test` 为 27 文件/252 测试，typecheck 退出 0；`build:uxp` 为 52 modules、`style.css 40.63 kB`、`plugin.js 318.42 kB` 且 verify 通过；`git diff --check` 仅 CRLF 提示，skip/todo/only=0，保护哈希仍为 `aa333f4b...e487` / `d83e11a3...b6d`。三轮上限已满，不再开启第 4 轮。
- 真机收尾完成：插件回到主配置页，Debug Inspector 已关闭，UDT 临时插件条目已移除且工作区为空；Photoshop 保持响应并最小化，Corel 原窗口已恢复前台。含请求头的临时截图与本轮界面截图已删除，未保存、关闭或改写用户 Photoshop/Corel 文档。

## 2026-08-14 心宝任务契约额外修复轮
- 用户明确解除上一轮阻塞并额外授权 1 次供应商契约修复轮；本轮禁止新付费生图，只修复 task/history 与既有任务恢复。
- 错误判卷标准已先收紧并取得红灯：`npm test -- --run tests/provider.test.ts tests/providerCapabilities.test.ts` 为 2 文件、28 测试中 `4 failed | 24 passed`；旧实现实际命中 `https://async.xinbao-ai.com/api/v1/tasks...`，通用兼容渠道也会猜测该端点，能力映射测试因函数不存在失败。
- 本轮目标契约：列表/详情固定走 `task.xinbao-ai.com/api/v1/tasks`，batch-get 固定走 `async.xinbao-ai.com/v1/tasks/batch-get`，鉴权只在请求头，历史/恢复调用的生成 POST 数必须为 0。
- Provider 契约绿灯：定向 `provider + capabilities` 为 2 文件/28 测试全部通过；心宝历史、batch 与余额三类 origin 独立映射，通用兼容渠道在无已确认契约时直接报告不支持且 fetch 为 0。
- 不确定任务恢复绿灯：定向 3 文件/34 测试全部通过，`img_7v2dfybbmw2gic3s` 夹具只命中 `POST https://async.xinbao-ai.com/v1/tasks/batch-get`，返回 `succeeded` 与结果 URL 后面板数据来源标为插件、账本由 `uncertain` 对账为 `completed`，`/v1/images/generations` 调用数为 0；typecheck 同步退出 0，相关源码无 `clone(` 匹配。
- 零费用真机恢复通过：最新构建在 Photoshop 27.8.0 Validate + Load 成功（会话 `05dd4515-d8ed-4845-a13f-720c62055ee4`）；旧审计事故留下的唯一账本记录缺 taskId，按用户明确给定值一次性回填 `img_7v2dfybbmw2gic3s` 后仍保持 `uncertain`，重载插件再由生产云端页自行恢复。
- 真机 fetch 边界：任务调用仅 1 个 `POST https://async.xinbao-ai.com/v1/tasks/batch-get`、HTTP 200，生成 POST 数严格为 0；另有插件正常余额 GET，不包含任务历史或生成请求。账本最终为 `postCount=1`、`status=completed`，云端页显示 `succeeded`、taskId、模型和“本插件提交”。
- React 已解析状态只读确认结果 URL 为 `https://gemini.xinbao-ai.com/proxy/image?...`，未用 `Response.clone()` 或二次 batch 请求；返回生成页后 `img` 数为 0，运行时 fetch 审计包装已移除，活动用户文档始终为 `1M9A3869.JPG` 且未写入。
- 本额外修复轮唯一一次完整门禁全部通过：`npm test` 为 25 文件/241 测试通过；`npm run typecheck` 退出 0；`npm run build:uxp` 为 50 modules、`style.css 38.90 kB`、`plugin.js 314.41 kB` 且 UXP verify 通过；`git diff --check` 退出 0（仅 CRLF 提示）；保护目录仍为 35 files/`aa333f4b...e487` 与 4808 files/`d83e11a3...b6d`。
- 零费用真机历史契约补证：账本完成后重新加载生产插件，云端页唯一任务历史请求为 `GET https://task.xinbao-ai.com/api/v1/tasks?limit=100`、HTTP 200，列出近三天 6 条任务，生成 POST 为 0；活动文档仍为 `1M9A3869.JPG` 且未写入。
- 同一安全 Key 仅放 Authorization 请求头，请求 `GET https://task.xinbao-ai.com/api/v1/tasks/img_7v2dfybbmw2gic3s` 返回 HTTP 200、`succeeded` 与 1 个结果 URL，生成 POST 仍为 0；读取响应使用正常 `response.json()`，未 clone、未输出 Key。
- UXP 设置记忆真机补证：文生图数量通过真实 `+` 控件由 1 改为 2，Validate + Load 重建后仍为 2；再通过真实 `-` 控件恢复为 1，第二次重建后仍为 1。全程未触发生成、未切换或写入活动 `1M9A3869.JPG`；该证据只证明插件重载持久化，不冒充 Photoshop 进程重启或三模式全部人工验收。
- 两类提示词历史真机只读补证：真实 UXP “提示词本”先显示 3 条手工收藏及独立“收藏/历史”标签，切到历史页显示 0 条和明确空态，再返回主配置；未调用、删除、清空或新增任何记录，活动文档未变。该证据证明两类页面真实分离，不替代“供应商成功后自动写入历史”的付费真机项。

## 2026-08-14 付费任务单次提交与结果可恢复治理
- 目标：每个用户生成意图最多一次付费 POST；有效图片先归入文档会话，Photoshop 写入失败只重试写入，不丢结果、不再生图。
- 顺序：冻结基线与 POST 调用链 -> 账户闸门/三日账本 -> 生成与写入分阶段 -> 单图直写 -> 设置记忆/提示词历史/云端记录 -> 最多三轮完整验收。
- 最大风险：供应商未证实幂等键且既有账单无法区分插件第二次 POST 与供应商内部重复建单；实现必须靠本地闸门和 fetch 边界计数证明，不伪造协议能力。
- 任务 0：`npm test` 为 20 文件/197 测试全部通过；`npm run typecheck`、`npm run build:uxp`、`git diff --check`、`node scripts/check-protected-dirs.cjs` 均退出 0；skip/todo/only 搜索为 0。
- 构建基线：46 modules，`uxp/style.css 33.79 kB`、`uxp/plugin.js 284.09 kB`，UXP verify 通过；保护目录摘要仍为 35 files/`aa333f4b...e487` 与 4808 files/`d83e11a3...b6d`。
- 关键行数以 `Get-Content(...).Count` 与 `rg` 末行号双重核对：`usePrototypeState.ts=1785`、`provider.ts=408`、`Shared.tsx=823`，与任务书一致；`Measure-Object -Line` 会低报空白行，未采用该数字。
- 当前工作树已有大量源文件、测试和生成产物修改；本目标只在白名单内追加最小改动，两个 demo、验收脚本、依赖、Key 和无关修改保持只读。
- 任务 1 红灯：真实 `OpenAIImageProvider` + fetch 边界定向测试失败为 `1 failed | 15 skipped`；同一 `localRequestId` 并发两次实际得到 2 个 `/v1/images/generations` POST，严格等于 1 的断言在 `tests/provider.test.ts:71` 失败。
- 任务 1 首个绿灯：发布 in-flight Promise 前的持久化竞态曾让第二个同 ID 被误判为另一任务；把 Promise 在异步持久化前登记后，同一 provider/fetch 测试为 `1 passed | 15 filtered`，两个调用共享结果且生成 POST 严格为 1；随后 `npm run typecheck` 退出 0。
- 任务 1 完成（自动化范围）：新增跨文档/跨 provider 的账户级闸门与三日最小账本；账本只保存 localRequestId、documentId、mode、model、submittedAt、postCount、providerTaskId、status、promptHash，不保存 Key、提示词或图片。同 ID 并发共享一次 POST，不同文档并发在 fetch 前阻断，POST 后不确定状态禁止自动重提；定向为 2 文件/23 测试通过。
- 任务 2 完成（状态与 UI 范围）：生成成功先登记候选资产；数量 1 不进入候选页而直接写入，Photoshop 写入失败转入独立“图片已生成，重试写入”页并保留内存图片，重试/放弃只操作写入或资源，不重新调用生成服务；数量 2-4 仍进入候选页。
- 任务 3 设置与提示历史完成：三模式分别记忆模型、分辨率、质量、数量、比例和输出位置；关闭记忆后重启用默认值，恢复默认不清提示词/参考图/Key。成功取得有效图片即写入独立本地提示历史，失败或空提示词不写，去重且最多 50 条，可筛选、复用、单删和二次确认清空。
- 任务 3 云端记录完成（离线范围）：仅使用 `/api/v1/tasks?limit=100`、`/api/v1/tasks/{id}`、`/api/v1/tasks/batch-get` JSON 接口；列表支持 401/429/空态/手动刷新，按本地账本标注来源，缩略图显式懒加载并以 12 个 Blob URL 为上限，关闭页面、换 Key 和卸载均释放。Provider 定向 20/20、缓存 3/3、UI 56/56 通过。
- 云端 UI 红→绿：首次接线后既有紧凑布局契约为 `2 failed | 81 passed`；保留页头右推 CSS 和 footer 源码顺序后，同组恢复为 4 文件/83 测试通过，未改测试断言。
- UXP 参数对齐：模型、分辨率、质量、输出位置和比例保留原生 select 交互，但以独立 DOM 文本层居中显示，不再依赖 UXP 的 `text-align-last`；数量输入继续原生居中。UI 定向 56/56、typecheck 退出 0；280/320/360 真机外观仍待用户空闲时复核。
- 任务 4 真实 Hook 链完成：实际挂载 `usePrototypeState()`，只替换外部凭据/HTTP/Photoshop 边界，生产 `DocumentSessionCoordinator -> GenerationService -> OpenAIImageProvider -> AssetLifecycleManager -> writeSingleCandidate` 全链运行。第一次 Photoshop insert 故意失败后进入 write-recovery 且候选字节仍在，重试 insert 成功并清空候选；fetch 边界 `/v1/images/generations` POST 严格为 1。初次测试因错误伪造仅含 `auto` 的模型表而正确红灯，改用已确认 `gpt-image-2-oai` 后为 1/1 通过。
- 集成对抗补齐：真实 Hook 卸载发生在付费 POST 已发出、响应未知时，重建后新点击被账户闸门阻止，生成 POST 仍为 1；写入失败时非空提示词已进入本地历史，生成完成会自动查询云端记录。Provider 明确覆盖 6 秒后跨文档点击与轮询瞬断，均断言生成 POST 为 1；单图状态表覆盖三模式及文生图两种输出位置。定向合计 3 文件/39 测试通过。
- 云端三日边界收紧：列表在 JSON 归一化后再次按创建时间过滤并倒序，只显示当前时刻前 3 天内的任务；缺创建时间、过期或异常未来时间的记录不冒充“三天内”。Provider/缓存/Hook 定向 3 文件/27 测试通过。
- 第 1 轮完整门禁：`npm test` 为 25 文件/235 测试全部通过；`npm run typecheck` 退出 0；`npm run build:uxp` 为 50 modules、`style.css 38.90 kB`、`plugin.js 313.70 kB` 且 verify 通过；`git diff --check` 退出 0（仅 CRLF 提示）；保护目录仍为 35 files/`aa333f4b...e487` 与 4808 files/`d83e11a3...b6d`。skip/todo/only 搜索无匹配，`uxp/` 无 `.uxprc` 残留。
- 当前关键行数：`usePrototypeState.ts=2139`、`provider.ts=540`、`Shared.tsx=989`；增长来自本任务 Hook 接线、云端适配与两类历史 UI，未为行数建议做破坏性拆分。真机门禁仍按 `BLOCKED.md` 保持未完成。
- 第 2 轮完整门禁（缩略图关闭竞态修复后）：`npm test` 再次为 25 文件/235 测试全部通过；typecheck 退出 0；build:uxp 为 50 modules、`style.css 38.90 kB`、`plugin.js 313.80 kB`、verify 通过；diff check 退出 0（仅 CRLF 提示）；保护目录两份哈希仍与基线一致。未发现需开启第 3 轮的自动化问题。
- 完成审计补强：真实 Hook 测试现为 5/5，通过同一生产链证明即时双击、6 秒后二次点击、生成中切到第二文档、轮询失败、写入失败重试、放弃结果、卸载重建均只有 1 次生成 POST；放弃后原候选 `bytes.byteLength=0`。设置记忆开关、手工收藏、自动提示历史和云端任务记录同时存在且互不覆盖。增强测试曾因真实存储含 3 条默认收藏而 1/5 红灯，改为验证包含新增收藏后恢复 5/5，未放宽付费 POST、字节归零或历史隔离断言。
- 第 3 轮最终完整门禁：`npm test` 为 25 文件/238 测试全部通过；`npm run typecheck` 退出 0；`npm run build:uxp` 为 50 modules、`style.css 38.90 kB`、`plugin.js 313.80 kB` 且 verify 通过；`git diff --check` 退出 0（仅 CRLF 提示）；保护目录仍为 35 files/`aa333f4b...e487` 与 4808 files/`d83e11a3...b6d`。三轮上限已满，不再开启第 4 轮；Photoshop 真机项继续保留在 `BLOCKED.md`。
- 付费真机续验（用户明确授权）：通过 UXP 服务英文临时联接加载同一份最新 `uxp/`，Photoshop 27.8.0 会话 `f90d9320-1209-43cd-8d7f-0a2567264fda`；CDP 确认活动安全夹具 `ps-fill-paid-acceptance-20260814.png` 为 512x512，用户未保存文档未参与测试。
- 真机云端记录失败：点击云端记录后实际显示 `云端记录接口不可用（404）`；生产代码请求 `/api/v1/tasks?limit=100`，而同一凭据对供应商 `/v1/tasks/batch-get` 查询成功。该缺陷使 POST 后不确定任务无法从插件 UI 对账或恢复，详见 `BLOCKED.md`。
- 付费单次提交证据：1K/低质量/数量 1，同一事件循环连续点击生成两次，网络仅 1 个 `POST https://async.xinbao-ai.com/v1/images/generations`；返回 HTTP 202、taskId `img_7v2dfybbmw2gic3s`、`accepted`。余额由 3,077 降至 3,065，仅消耗 12 积分。
- 审计包装故意失败后保护生效：运行时为读取 taskId 调用了 UXP `Response.clone()`，导致原响应被耗尽，插件日志红灯为 `[generative-fill] generation failed Error: API 未返回图片或任务 ID`；重载后重新输入同一提示词并点击，网络调用数为 0，证明持久化不确定账本阻止第二次付费 POST。
- 供应商对账：只查询既有 taskId，`/v1/tasks/batch-get` 返回 HTTP 200、`succeeded`、1 个 URL 结果，创建到完成约 51 秒。结果已下载为 `C:\Users\Administrator\AppData\Local\Temp\ps-fill-paid-result-img_7v2dfybbmw2gic3s.png`，2752x1536、2,874,076 bytes、SHA256 `B166667FD06CB559BD0904EB58168D5B2F8D11A94AA799D012A94E06B99A8C68`；插件存储内临时副本已删除。
- 真机收尾：专用测试文档通过 `executeAsModal` 无保存关闭，复核 `fixtureOpen=false`，Photoshop 活动文档恢复为原 `1M9A3866.JPG`；未保存、关闭或修改任何用户照片。三轮完整修复上限已满，本轮只记录真机缺陷，不开启第 4 轮代码修复。

## 2026-08-11 候选资源与多文档会话治理
- 目标：候选最多 4 张且不形成历史库存；每文档独立会话，离开结果页、关闭文档或正常关闭插件时释放插件资源。
- 顺序：冻结基线与资源追踪 -> 生命周期管理 -> 文档协调器 -> 单临时预览层 -> 重绘意图规划 -> 最多三轮门禁与真机记录。
- 最大风险：当前工作树已有大量未提交实现，`usePrototypeState.ts` 实测 1527 行而非任务书 1599 行；不得通过回退或覆盖来追齐旧数字。
- 安全边界：只清理带插件所有者前缀且登记 documentId/jobId/revision 的资源；用户原图和普通图层始终优先保护。
- 任务 0 基线：`npm test -- --reporter=dot` 为 16 文件/175 测试全部通过，输出未列 skip/todo；typecheck、build:uxp/verify、diff check、保护目录检查均通过。
- 保护目录基线：`compact-panel-demo` 35 files / `aa333f4b...e487`；`compact-panel-demo-v2` 4808 files / `d83e11a3...b6d`。
- 关键行数：`src/usePrototypeState.ts` 1527；任务书数字偏差与真机前置限制已写入 `BLOCKED.md` 顶部。
- 既有修改已冻结：当前 status 包含 24 个已修改项与 17 个未跟踪项；两套 demo、`docs/`、`promptNotebookStorage` 等范围外内容只读保护。
- 资源追踪进行中：现有候选字节同时存于 `Candidate.asset.bytes` 和 Blob URL；预览当前一次把全部候选插入 Photoshop，多图层行为是任务 3 的直接缺口。
- 任务 4 完成：`InpaintIntentPlanner` 已接入本地重绘请求，明确提示词优先，空提示词编译为结构化移除并连续修复意图；双下巴、多余头发、衣物露出、皮肤瑕疵和背景杂物均有回归。
- 任务 4 红→绿：新增模块首次运行因尚未存在得到 `ERR_MODULE_NOT_FOUND`；实现后兼容套件曾为 9 项失败，补齐既有语义后最终命令为 3 文件/75 测试全部通过。
- 任务 1 完成（自动化范围）：候选字节、Blob URL、上传结果、选区通道和单预览层均按 documentId/jobId/revision/`ps-fill` 前缀登记；重复清理、跨文档隔离、取消后字节归零、图片字节/像素/解码尺寸上限和会话内上传复用均有测试。
- 任务 2 完成（自动化范围）：`DocumentSessionCoordinator` 已接入生成入口和所有异步回调；快速双击只保留一个令牌，取消保留原 jobId 到终态，revision 不匹配的迟到回调被丢弃，关闭文档同步关闭协调状态。
- 任务 3 完成（自动化范围）：实际预览路径每次只向 Photoshop 网关传 1 个候选，切换时先删旧临时层再放新层；确认转正式层后、返回配置和关闭文档均释放候选库存。
- 所有权前缀红→绿：旧网关测试有 3 项仍要求无前缀文件/通道名，更新为安全契约后定向回归 7 文件/114 测试通过；自审发现双击门禁误放完成回调并已移回生成入口，全量回归通过。
- 第 1 轮完整门禁：`npm test -- --reporter=dot` 为 20 文件/193 测试全部通过；`npm run typecheck`、`npm run build:uxp`（46 modules，plugin.js 282.39 kB，verify 通过）、`git diff --check` 和保护目录检查均通过。
- 资源泄漏自审修复：局部重绘选区通道在取消竞态下改为先登记再核对 revision；生成失败统一清理原 documentId/jobId/revision；无预览资产的早退不再卡住 `previewStaging`。
- 临时文件统一登记：Photoshop 截图、Klein 上下文、候选写入和回退蒙版文件均携带 documentId/jobId/revision/`ps-fill` owner 进入 `AssetLifecycleManager`；清理按 owner 隔离，文件名加入进程内序号避免同毫秒碰撞。
- 临时文件红→绿：首次定向回归因无 owner 的旧 mock 收到额外 `undefined` 参数而 2/36 失败；保持旧调用形状后 `photoshopGateway` + lifecycle 定向测试 36/36 通过，新增测试证明清理文档 A 不触碰文档 B。
- 第 2 轮门禁（临时文件接线前）：20 文件/196 测试通过，typecheck、build:uxp（46 modules，plugin.js 282.51 kB）、diff check 和保护目录检查通过。
- 真实主机加载：Photoshop 27.8.0、UXP 服务端口 14001；最终 `uxp/manifest.json` 返回 `Manifest is validated successfully`、`Load command successfull`、`Plugin Load Successfull`，会话 `3475b5e8-db5c-4141-a508-8029b3824bda`；CLI 生成的 `uxp/.uxprc` 已移除，未点击生成或写入文档。
- `usePrototypeState.ts` 最终 1710 行；未为 300–500 行建议做大范围重构，因为现有工作树包含既有会话/UI 改动，强拆会扩大回归面。本轮只抽出任务要求的四个协调模块并优先保证原图安全与行为正确。
- 第 3 轮最终门禁：`npm test -- --reporter=dot` 为 20 文件/197 测试全部通过，skip/todo/only 搜索无匹配；`npm run typecheck` 通过；`npm run build:uxp` 为 46 modules、`style.css 33.79 kB`、`plugin.js 284.09 kB` 且 verify 通过；`git diff --check` 通过（仅 CRLF 提示）；保护目录哈希与基线完全一致。最终 `usePrototypeState.ts` 为 1710 行。
- 真机安全夹具：创建并打开 `C:\Users\Administrator\AppData\Local\Temp\ps-fill-acceptance-20260811.png`，实测 `512x512`、5966 bytes、SHA256 `71C191A9C9007FA7A79224C735ABE8E8BA804588FAFB64A6E7DD0D388B2406FC`；Photoshop 活动文档 ID 2155，未把原用户文档当作测试材料。
- 最新产物再次通过 Photoshop 27.8.0 的真实 Validate + Load，UXP 会话 `7a8badea-ac29-4b65-92e0-fb5bec6535df`；CDP 只读取得面板状态：3,119 积分、数量 4、增加按钮已禁用、空提示词下生成按钮禁用。该证据只证明加载和数量上限，不冒充生成/清理验收。
- 本地 ComfyUI 既有安装按历史授权启动后，`/system_stats` 返回 `COMFY_ONLINE`、ComfyUI `0.28.0`、Python `3.11.9`；用户表示需要使用桌面后立即停止真机控制，并仅停止本轮启动的 PID 23240，复核为 `COMFY_STOPPED`。未提交 `/prompt`、未调用付费 API、未写入或保存 Photoshop 文档。
- 用户开始工作后不再进行任何 Photoshop/UXP 桌面操作；连续 10 轮、生成中切文档、取消、关闭/重启与逐轮资源计数保持未验收，详见 `BLOCKED.md`。三轮完整修复与验收上限已用完，不启动第 4 轮代码修复。

- 2026-07-30：完成最终真机验收。最新 UXP 产物在安全副本中真实调用本地 Klein 9B；ComfyUI 队列记录了明确的“移除双下巴”指令和空提示词的“擦除并自然重建”内部指令。两次单候选写回均保持 crop `(220,1386)-(2344,3028)` 与 selection `(751,1917)-(1813,2497)` 精确对位，选区外 3 通道最大误差均为 `0`。3 候选仅改变 seed，Photoshop 中三层 transform 与 `2124×1642` 尺寸完全相同；点击第二张实时切换成功，确认后仅保留选中的图层。最终门禁为 13 个测试文件、105/105 通过，typecheck、build:uxp、UXP 校验、git diff --check 全部通过。

## 2026-07-30 文档会话隔离目标
- 任务 0 重跑：`npm run typecheck`、`npm test -- --reporter=dot`、`npm run build:uxp` 全部通过；当前为 13 个测试文件、111/111、0 跳过，UXP 校验通过。
- 当前工作区保留既有未提交改动；`git status --short --branch` 显示 main 及既有源文件、UXP 产物、保护目录和测试改动。
- 目标：把候选、进度、配置、预览会话和资源按 Photoshop `documentId` 隔离；切换文档只激活对应会话，后台完成不得抢占当前文档。
- 顺序：纯状态映射与测试 → 活动文档检测 → 异步任务归属/资源清理 → UXP 构建与三文档验收。
- 最大风险：当前生成状态和候选状态均为全局单例，且 Photoshop 真机切换事件需在不进入 modal 的前提下可靠捕获。
- 2026-07-30：新增 `src/documentSessionState.ts`，会话按 `documentId` 保存草稿、上下文、任务、候选和预览状态；纯状态测试覆盖同名文档隔离、改名保留、关闭单项清理和后台完成不抢当前会话。
- 2026-07-30：UXP 活动文档检测改为 400ms 非 modal 轮询，结合可用文档 ID 清理关闭文档；生成回调同时校验启动文档 ID、任务 ID 和任务仍处于 queued/running，迟到结果不会覆盖新任务。
- 2026-07-30：Blob URL、AbortController、计时器和预览队列改为按文档资源表管理；切换文档只切换视图，结果在切回源文档后再进行预览写入。
- 2026-07-30：当前离线门禁为 14 个测试文件、116/116、0 跳过，typecheck、UXP build/verify、git diff --check 均通过；真实 Photoshop 三文档切换仍待外部主机可控后验收。
- 2026-07-30 17:01：最终离线门禁复跑：`npm run typecheck`、`npm test -- --reporter=dot`（14 文件/116 测试/0 跳过）、`npm run build`、`npm run build:uxp`、保护目录摘要和 `git diff --check` 全部通过；未触碰两套保护目录。
- 2026-07-30：`getOpenDocumentIds` 对不同 UXP 文档集合形态增加安全回退；无法枚举时至少保留活动文档，避免轮询误删全部离线会话。
- 2026-07-30：活动文档轮询区分“无文档”与“临时读取失败”；读取失败不再把已有会话批量清空，也不把当前 UI 错切到空状态。
- 2026-07-30 17:05：收尾门禁：14 个测试文件/116 测试/0 跳过，typecheck、build:uxp（含 UXP 校验）、保护目录摘要、diff check 全部通过；Photoshop 真实三文档 10 次切换仍未执行，详见 BLOCKED.md。

## 2026-07-29 02:31 任务书续接基线
- 目标：只用本地 Klein 做局部重绘；文生图/整图重绘继续只走心宝，缺 ComfyUI 时明确阻止。
- 顺序：能力核对 → 路由/工作流 → 精确蒙版与色彩写回 → 反向测试 → 真机与 20 张验收。
- 最大风险：20 张验收目录 `D:\Klein验收样片` 尚不存在；未获得 18/20 证据前保持“实验性”。
- `git status --short --branch`：main，保留既有源改动与两套保护目录，未发现本任务外新增目录。
- `npm test`：13 文件 / 87 测试 / 0 跳过；`npm run typecheck`：通过。
- `npm run build:uxp`：通过（UXP 产物校验通过）；`git diff --check`：通过（仅 CRLF 提示）。
- `node scripts/check-protected-dirs.cjs`：两套目录摘要均与基线一致。
- ComfyUI `/system_stats`：0.28.0、RTX 2080 Ti、可用显存约 10.0 GB；五个指定模型文件均存在。
- `/object_info`：3943 节点；本地核心 Klein 工作流所需节点全部存在；下一步审计真实响应兼容与写回色彩链路。

- 2026-07-29 00:58：ComfyUI 已由用户授权从 `D:\ComfyUI-aki-li\ComfyUI` 启动，`/system_stats` 返回 200，版本 `0.28.0`；本轮修复临时蒙版快照不再调用会触发“建立命令不可用”的 `make user mask`，改为选区外黑/选区内白的灰度 PNG，保留任意形状选区。新增回归后 `npm test` 为 13 文件/87 测试/0 跳过，typecheck 与 build:uxp 通过；Photoshop 真机写回复核待重新执行。
- 2026-07-28 12:09：最新 UXP 产物通过 Adobe 本地服务 Validate + Load，插件会话 `f979e774-e633-437b-9603-4725c6c32732`；`npm test` 为 10 文件/70 测试/0 跳过，typecheck、build:uxp、diff check 与保护目录摘要均通过。
- 2026-07-28 12:09：真机已确认真实 DOM 符号图标可见；积分已并入标题栏，280/310/360px 无横向溢出，独立积分行不存在。
- 2026-07-28 12:23：安全测试文档完成整图重绘与局部重绘两次真实生成，各消耗 12 积分；整图新增命名智能对象图层，原背景保留且无图层组。
- 2026-07-28 12:23：局部重绘空提示词生成成功；“智能填充”图层边界为 `(128,128)–(384,384)`，运行时描述符确认 `hasUserMask=true`、`userMaskEnabled=true`，原背景与整图重绘层均保留。
- 2026-07-28 12:23：对抗审查修复局部重绘比例与写回位置：API 比例跟随选区，图层缩放并移动到选区后创建 reveal-selection 蒙版；真实写回已验证。
- 2026-07-27 21:01：通过 Adobe UXP Developer Tool 本地服务连接 Photoshop 27.8，对最终 `uxp/manifest.json` 执行真实 Validate + Load；返回插件会话 `08b2320a-7913-4867-8e9b-5ae1336cd741`，未执行生成或文档写入。
- 2026-07-27 20:36：中间版真机截图确认 UXP 会忽略伪元素图标；后续最终改为真实 DOM 符号，避免依赖 SVG/PNG 解码。
- 2026-07-27 20:36：图标回归测试先红后绿；浏览器实测 11 个设置/主面板图标均 `complete=true` 且 `naturalWidth>0`，359px 设置抽屉 `scrollWidth=clientWidth`。
- 2026-07-27 20:36：当前自动化为 10 个测试文件、69 项通过、0 跳过；typecheck、build:uxp、UXP 产物校验、diff check 与保护目录摘要均通过。
- 2026-07-27 20:36：未在用户离开后操作其未保存的 Photoshop 文档，也未追加付费生成。

- 目标：打通通用 OpenAI 兼容文生图、真实下载与 Photoshop 非破坏性插入。
- 顺序：冻结基线 → 契约测试红灯 → Provider/凭据/Photoshop 网关 → 前端接线 → 自动化与真实验收。
- 最大风险：UXP 运行时模块只能在 Photoshop 内验证，不能用浏览器构建结果替代。
- 2026-07-27：任务 0 完成；Git 仅有两套受保护未跟踪目录，typecheck/build:uxp 通过，npm test 按预期缺失。
- 2026-07-27：`src/styles.css` 无差异；保护目录摘要与任务书一致。
- 2026-07-27：新增后端契约测试；首次 `npm test` 因三个目标模块尚不存在而红灯，已保留终端证据。
- 2026-07-27：用户提供本地 `AII开发文档.txt` 修正版并指定为唯一最新依据；已撤销旧网页的50秒单任务GET方案，改为 batch-get、2K尺寸表、21:9、提示词前缀及模型专属 quality。
- 2026-07-27：用户覆盖一期边界：允许参考图上传第三方，要求整图重绘及局部重绘；空局部提示词表示上下文自然补全。
- 2026-07-27：参考图支持本地选择/拖放、当前可见画面和当前选区截图；Litterbox 24 小时临时上传后按 `image` URL 数组提交。
- 2026-07-27：新增整图重绘和局部重绘；后者提交完整画面、选区截图和坐标，并用任务启动选区的图层蒙版非破坏性写回原文档。
- 2026-07-27：网络生成不持有 Photoshop modal；进度区显示阶段、百分比与耗时，结果绑定启动文档 ID，切换文档后不会误插。
- 2026-07-27：浏览器 360px 视觉检查通过，三个模式、三个参考来源入口和进度信息未破坏紧凑布局。
- 2026-07-27 16:40：本机 UXP Developer Tool 对 `com.codex.generative-fill` 执行 Reload，日志确认 Validate/Load/Plugin Load Successful；Photoshop 27.8 的“生成填充”面板已存在。
- 2026-07-27：自动验收为 5 个测试文件、24 个测试全部通过；typecheck、build:uxp、diff check 和两份保护目录摘要均通过，跳过测试、`src/styles.css` 差异和高可信密钥模式命中均为 0。
- 2026-07-27：真实探测发现 Xinbao `batch-get` 使用无效 Key 仍返回 200/not_found；连接状态已拆分为“服务可达”和“凭据正常”，避免假阳性绿灯。
- 2026-07-27：Windows 运行态确认 Photoshop 2026 已打开真实文档、生成填充面板存在，UXP Developer Tools 显示 `com.codex.generative-fill` 为 Loaded；当日日志再次确认 Validate/Plugin Load Successful。
- 2026-07-27：真机截图复现两处 UXP 兼容问题：`network.domains` 误写为 `["all"]` 导致域名权限拒绝；凭据层依赖 UXP 未保证提供的 `TextEncoder/TextDecoder` 导致安全存储失败。已改为 `"all"` 与 secureStorage 原生字符串写入/字节读取。
- 2026-07-27：新增 manifest 回归测试；完整验收现为 6 个测试文件、25 个测试通过，最终 `uxp/manifest.json` 已确认 `NetworkDomains="all"`。
- 2026-07-27：用户真机截图确认修正版已生效：API Key 安全存储不再报错，Xinbao `batch-get` 可达，面板正确显示“服务可达（Key 未验证）”而非假阳性鉴权成功。
- 2026-07-27：第一次真实付费生成验收通过：文生图返回真实白花候选，面板提示已插入 1 个候选；Photoshop 当前文档出现独立时间戳“生成填充”图层组及 `generated-0`，原始锁定“背景”图层仍保留。
- 2026-07-27：第二次真实付费生成成功创建尺寸随 API 结果的新文档，但真机截图发现时间戳组为空、首图仍是外部锁定“背景”层；根因是对 `app.open(PNG)` 产生的背景层执行改名/移动未生效。
- 2026-07-27：新文档首图写入改为复用已真机验证的 `placeEvent` 置入组内，再删除临时背景层；回归测试先红后绿。完整验收现为 6 个测试文件、26 个测试通过，typecheck/build:uxp/diff check/保护摘要均通过。
- 2026-07-27：用户再次覆盖输出规则：当前文档和新建文档均不再创建图层组，结果直接作为图层写入；图层名从提示词提炼为内容描述（如“黑色小狗”“白色小花”），空提示词局部重绘使用“智能填充”。回归测试先出现 3 个预期红灯，修复后 6 个测试文件、28 个测试通过，typecheck/build:uxp/保护摘要均通过。
- 2026-07-27：最终本地复核再次通过：`npm test` 为 6 文件/28 测试/0 跳过，`npm run typecheck`、`npm run build:uxp`、`git diff --check`、保护目录检查均成功；`src/styles.css` 与 `scripts/verify-uxp-build.cjs` 无差异，高可信密钥文件命中为 0。
- 2026-07-27：无费用 Photoshop 真机复核通过当前文档输出：当前画面作为测试素材经正式网关插入，原“背景”层保留且未覆盖，新结果直接成为独立普通图层“无费用验收图”，无图层组。
- 2026-07-27：无费用新建文档首轮复核发现 UXP DOM 对锁定背景层直接赋名静默无效；改用 Photoshop Action Manager 将背景转普通图层并命名。修复版真机截图确认新文档尺寸正确且仅有普通图层“无费用验收图”，无锁定背景、无图层组。临时无费用测试入口已从最终版移除。
- 2026-07-27：正式交付包完成最终重建：6 个测试文件/28 项测试/0 跳过，typecheck、UXP 构建与校验、`git diff --check`、两套保护目录摘要、样式/校验脚本只读检查及高可信密钥扫描全部通过。
- 2026-07-27：日用稳定版任务 0 复核通过：28/28 测试、typecheck、diff check 与两套保护目录摘要均保持基线。
- 2026-07-27：生成门控改为统一优先级，灰色按钮直接显示缺失原因；参考图入口收敛为加号、本地多选、拖放与图片粘贴，移除三个旧按钮并防重复。
- 2026-07-27：API Key 改为显式保存/删除，UXP secureStorage 读写错误统一脱敏；设置页明确说明 Key 会发送至用户配置的 Base URL。
- 2026-07-27：配置态与结果态已分离，返回修改保留参数；新增红→绿回归后为 7 个测试文件、42 项测试、0 跳过，280px/360px 浏览器无横向溢出。

## 2026-07-28 Klein 本地局部重绘

- 目标：局部重绘只走本地 ComfyUI/Klein；文生图与整图重绘继续只走现有心宝 Provider。
- 顺序：基线与本机能力核对 → Provider/路由 → Klein 工作流 → 精确蒙版与安全写回 → 自动化反证 → 真机与20张验收。
- 最大风险：ComfyUI 当前未运行，无法核对 `/system_stats`、`/object_info`，也暂时不能完成真机工作流与质量验收。
- 基线：`git status --short --branch` 仅有受保护的 `compact-panel-demo/`、`compact-panel-demo-v2/` 未跟踪。
- 基线：`npm test` 为 10 文件/70 测试/0 跳过；`typecheck`、`build:uxp`、`git diff --check`、保护目录检查全部通过。
- 模型：9B/4B diffusion、对应 Qwen text encoder 与 `flux2-vae.safetensors` 五个指定文件均存在。
- 服务：`http://127.0.0.1:8188/system_stats` 与 `/object_info` 均连接失败；已写入 `BLOCKED.md`，继续实现不依赖真机服务的部分。
- 约束：不自动启动 ComfyUI、不回退心宝、不改 ComfyUI 安装内容，不触碰两套受保护 demo、积分与凭据逻辑。
- 2026-07-28 22:21：本轮测试基线：`npm test` 13 文件/81 测试/0 跳过；`npm run typecheck`、`npm run build:uxp`、`git diff --check` 与 `node scripts/check-protected-dirs.cjs` 全部通过。Klein 五个指定模型文件均存在（9B diffusion 9.43GB、9B Qwen 8.66GB、4B diffusion 4.09GB、4B Qwen 8.04GB、VAE 336MB）。
- 2026-07-28 22:21：真实本机冒烟仍被外部运行态阻塞：`http://127.0.0.1:8188/system_stats` 与 `/object_info` 均“无法连接到远程服务器”；未启动 ComfyUI，未发送 `/prompt`，未调用心宝。三组本地路由/Provider/几何测试 11/11 通过，证明离线会具体报错、局部重绘不会回退心宝、原始蒙版外像素保持不变。
- 2026-07-28 22:24：按用户授权启动 `D:\ComfyUI-aki-li\ComfyUI`；真实 `/system_stats`、`/object_info` 通过，3943 个节点中所需 18 个全部存在，9B/4B diffusion、Qwen 与 VAE 清单全部匹配。9B 单图真实 `/prompt` 冒烟 21.29 秒完成，结果仅写入临时 PreviewImage；详见 `docs/KLEIN_ACCEPTANCE.md`。
- 2026-07-28 22:46：任务1界面缺口已补齐：设置抽屉新增本地 ComfyUI 地址、真实连接检测和 9B/4B 档位；局部模式仅显示 Klein 档位与数量，隐藏心宝模型、质量、分辨率和参考图。新增 2 项 UI 回归后完整测试为 13 文件/83 测试/0 跳过，typecheck、build:uxp、diff check 与保护目录检查全绿。
- 2026-07-28 22:47：最新 `uxp/` 产物经 Adobe UXP Developer Tools 本地服务真实 Validate + Load 成功，插件会话 `100631de-b141-4df0-a6e8-916de134d146`；未触发生成或用户文档写入。
- 2026-07-28 23:15：4B Base 真机对照完成：`512×496`、20 steps/CFG5/Euler、32.25 秒、`prompt_id=d01cc9c7-5533-4875-ba7a-eeb86d4d0183`；链路成功但结果出现粉色卡通下巴，判定不可用。读取本机官方 Klein 4B 工作流后发现其使用 `ImageScaleToTotalPixels + GetImageSize` 的专用参考链路，当前核心工作流尚未复刻该差异；不盲目晋级，记录为待修缺口。
- 2026-07-28 23:40：按本机官方 `image_flux2_klein_image_edit_4b_base.json` 复刻参考链路：`ImageScaleToTotalPixels(nearest-exact, 1MP)` → `GetImageSize`，并让 VAE、latent 与 scheduler 统一使用缩放后的尺寸；ComfyUI 仅返回临时 `PreviewImage`，最终选区合成仍交给 Photoshop 原始任意形状蒙版。4B 真实请求成功，输出不再出现粉色卡通伪影；单元测试更新后 13 文件/84 测试/0 跳过，typecheck 与 diff check 通过。下一步是 Photoshop 4B 任意形状写回复核。
- 2026-07-28 23:43：默认 9B 也完成官方 1MP 参考链路真机复测：`prompt_id=7d44aa54-748e-4106-bb7a-61c8eab6b419`，37.40 秒完成，RTX 2080 Ti 未显存溢出；人物身份、肤色、结构与衣物连续，9B 继续作为默认质量优先档位。两档真实 ComfyUI 链路均已恢复，仍待 Photoshop 实际任意形状写回。
- 2026-07-28 23:50：新增 Photoshop 安全写回回归：任务期间文档尺寸变化会在任何写入前拒绝；任意形状快照蒙版按原始 PNG alpha 恢复为选区，禁止退化为边界矩形，并验证生成图/蒙版从模型坐标缩放到原裁切坐标。`photoshopGateway` 现为 9/9 通过，完整测试总数提升至 86 项。
- 2026-07-28 23:53：三组反向验证完成并保留真实红→绿输出：错误端口红灯后精确报错测试 1/1 通过；虚构缺失 9B 文件红灯后缺模型阻断测试 1/1 通过；关闭颜色匹配时合成中心偏色为 175（目标100）红灯，恢复匹配后边界色测试 1/1 通过。最终门禁仍以不带 `-t` 的完整测试 0 跳过为准。
- 2026-07-28 23:58：`npm run build:uxp` 后通过 Adobe UXP Developer Tools CLI 对当前 `uxp/manifest.json` 执行真实 Validate（`success=true`）并 Reload/Load（Photoshop 27.8，插件会话 `febd9f89-b23e-49d2-8cc6-8e48d0739ff9`）；只重载插件，未触碰用户文档。
- 2026-07-29 02:50：按用户授权确认 `D:\ComfyUI-aki-li\ComfyUI` 持续运行（ComfyUI 0.28.0，RTX 2080 Ti，`/system_stats` HTTP 200，`/object_info` 3943 个节点）；完整 `npm test` 为 13 文件/89 测试/0 跳过，`typecheck`、`build:uxp`、`git diff --check` 与保护目录检查全部通过。
- 2026-07-29 02:52：最新 UXP 产物通过 Adobe UXP Developer Tools CLI 真实 Validate + Load（Photoshop 27.8，会话 `6c6a3d5c-c240-43fa-a8c3-f474bc2ab9a6`）；本轮只加载插件，未执行 Photoshop 文档写回。
- 2026-07-29 03:05：静态审计发现候选插入路径此前丢弃 `selectionSnapshot`、退化为矩形选区；已改为局部结果优先传递原始灰度蒙版快照，并新增回归测试，路由测试 3/3 通过、typecheck 通过。
- 2026-07-29 03:06：修复后的完整门禁：`npm test` 13 文件/90 测试/0 跳过，`typecheck`、`build:uxp`、`git diff --check` 与保护目录检查全绿；本轮 UXP Load 因主机忙超时，未宣称最新产物已加载。
- 2026-07-29 03:08：修复蒙版写回的形状风险：临时 PNG 改为选区外透明、选区内白色，再用 `transparencyEnum` 载入；不再生成“全不透明黑白图”导致套索退化为裁切矩形。PhotoshopGateway/路由定向回归 13/13、typecheck 与 UXP 构建通过。
- 2026-07-29 03:15：安全审计发现原启动文档仍打开但用户切换到另一份文档时可能误写；`insertIntoCurrentDocument` 新增 activeDocument ID 门禁，切换即拒绝且不创建临时文件。PhotoshopGateway 回归 11/11、typecheck 通过。
- 2026-07-29 03:16：局部选区自动轮询现在只在非生成状态运行；排队/生成期间冻结启动快照，避免每 750ms 查询 Photoshop 与 modal 捕获/写回争用。完整测试 13 文件/91 项通过，typecheck 通过。
- 2026-07-29 03:18：ComfyUI 当前运行态完成 4B 单候选真实复核：`prompt_id=4ca5627c-dec0-4af4-8ace-f521be7c1412`，20 steps/CFG5/Euler，97.14 秒，经 `/history` 与 `/view` 得到 2,209,820 bytes 临时 PNG；队列复核为空，未写永久 output、未调用心宝或 Photoshop。
- 2026-07-29 03:21：完整门禁保持全绿：`npm test` 13 文件/91 项/0 跳过，`typecheck`、`build:uxp`（含 UXP 校验）、`git diff --check`、保护目录检查通过。Photoshop 仍 `Responding=False`，未执行最新产物 Load 或真机写回。
- 2026-07-29 03:31：再次无写入检查 Photoshop，窗口仍为 `1M9A3574.JPG @ 16.7% (智能填充, 图层蒙版/8) *`、`Responding=False`；未强杀、未发送 Enter/Esc、未自动重载。
- 2026-07-29 03:26：写回安全审计补充：局部快照路径不再在 `finally` 用边界矩形恢复选区，保留已载入的原始任意形状选区；普通矩形选区保持原恢复逻辑。PhotoshopGateway 定向回归 11/11、typecheck 通过。
- 2026-07-29 03:33：重新核对 ComfyUI 能力：版本 `0.28.0`、RTX 2080 Ti、`3943` 个节点，Klein 工作流所需 18 个节点均存在；五个指定模型均存在（9B diffusion 9,433,061,528 bytes；9B Qwen 8,664,848,742；4B diffusion 4,089,498,488；4B Qwen 8,044,982,048；VAE 336,213,556）。
- 2026-07-29 03:26：保留任意形状选区修复后的完整门禁再次通过：`npm test` 13 文件/91 项/0 跳过，`typecheck`、`build:uxp`、UXP 校验、`git diff --check`、保护目录检查全绿；最新 `uxp/` 已由构建生成，尚未 Load 到无响应的 Photoshop。
- 2026-07-29 03:27：Klein 设置区现在根据 `experimental` 状态显示“实验性”，避免在未完成 18/20 验收前误标正式主力；UI 定向回归 14/14、typecheck 通过。
- 2026-07-29 03:28：实验性标记后的完整门禁通过：`npm test` 13 文件/91 项/0 跳过，`typecheck`、`build:uxp`（含 UXP 校验）、`git diff --check`、保护目录检查全绿；最新 `uxp/` 已生成，Photoshop 仍未响应未 Load。
- 2026-07-29 03:29：快照选区异常路径加固：只有 `loadSnapshotSelection` 完整成功才保留精确选区；中途失败会恢复旧边界并继续抛出原错误。PhotoshopGateway 定向回归 11/11、typecheck 通过。
- 2026-07-29 03:30：异常路径修复后的完整门禁再次全绿：`npm test` 13 文件/91 项/0 跳过，`typecheck`、`build:uxp`、UXP 校验、`git diff --check`、保护目录检查通过；最新 `uxp/` 已生成但未 Load。
- 2026-07-29 03:32：局部 GenerationService 进入 Klein 前补发 `generating` 阶段，进度栏不再停留在“读取选区”；路由回归 3/3、typecheck 通过。
- 2026-07-29 03:33：本地 Provider 回归扩展为 2 张候选：断言上下文只上传一次、`/prompt` 顺序提交两次、seed 为 `20/21`，8 项 Provider 测试与 typecheck 通过。
- 2026-07-29 03:34：补充运行中取消回归：检测到 `queue_running` 时不发送删除、不调用 `/interrupt`；Provider 定向回归 9/9、typecheck 通过。
- 2026-07-29 03:34：补充缺核心节点门禁回归；缺 `ReferenceLatent` 在提交前给出具体错误，Provider 定向回归 10/10、typecheck 通过。
- 2026-07-29 03:35：本轮完整门禁全绿：`npm test` 13 文件/93 项/0 跳过，`typecheck`、`build:uxp`（含 UXP 校验）、`git diff --check`、保护目录检查均通过；最新 `uxp/` 已生成，未 Load 到无响应 Photoshop。
- 2026-07-29 03:37：本地连接测试的异步回调增加配置代际校验；用户修改地址/档位后，旧请求的成功/失败结果都会被忽略。typecheck 通过。
- 2026-07-29 03:37：连接测试修复后的完整门禁全绿：`npm test` 13 文件/93 项/0 跳过，`typecheck`、`build:uxp`、UXP 校验、`git diff --check`、保护目录检查通过；最新 `uxp/` 未 Load。
- 2026-07-29 03:36：在 `docs/KLEIN_ACCEPTANCE.md` 增加当前验收矩阵，明确自动化/ComfyUI 已通过，Photoshop 透明蒙版真机与20张晋级仍是外部阻塞；不把离线证据冒充真机通过。
- 2026-07-29：Photoshop 已恢复响应（进程 `Responding=True`），ComfyUI 仍运行在 `http://127.0.0.1:8188`。按用户决定，不再创建、扫描或代判 `D:\Klein验收样片`；20 张正式验收由用户自行完成，当前仍保留 Klein“实验性”标记，不能据此宣称 18/20 晋级。
- 2026-07-29：重新执行当前 `uxp/manifest.json` 的 Adobe UXP Developer Tools CLI Validate + Load，返回 `validated=true`、插件会话 `8bcc208c-42b8-4c61-97e4-d13242a3cf81`；只加载插件，未触发生成、未写入 Photoshop 文档。
- 2026-07-29 20:55：安全副本 `1M9A3574-klein-test-copy.psd` 已通过非破坏方式打开，Photoshop 进程 `Responding=True`。最新 UXP Validate 成功，但 Load 因主机模态状态超时；未进行猜点击、强杀或写回。当前自动门禁 13 文件/105 测试通过，typecheck、build:uxp、UXP 校验与 diff check 全绿；副本真机像素验收仍待窗口可控后执行。
- 2026-07-30 17:08：再次收尾门禁：`npm run typecheck`、`npm test -- --reporter=dot`（14 文件/116 测试/0 跳过）、`npm run build:uxp`、`git diff --check`、保护目录摘要全部通过；尝试初始化 Computer Use 时运行时直接返回 `Windows Computer Use Sky runtime is unavailable`，未猜测点击、未重载插件、未触碰 PSD。
- 2026-07-30 17:40：修复“生成完成后返回修改导致 Photoshop 无响应”：根因是候选预览写入/清理可并发触发 modal，且返回配置页后旧 effect 会因候选仍存在再次自动写入。`PhotoshopGateway` 新增预览 modal 串行队列；文档会话新增 `previewRevision`，迟到预览回调会被丢弃并清理已写入图层；仅结果页允许自动预览。新增 3 项回归，完整测试 14 文件/119 测试/0 跳过，typecheck、build、build:uxp、UXP 校验和 diff check 全部通过。
- 2026-07-30 17:42：保护目录复核通过：`compact-panel-demo` 与 `compact-panel-demo-v2` 摘要未变化；未发现诊断调试标记。
- 2026-07-30：当前 `uxp/` 产物已通过 Adobe UXP Developer Tools 真实 Load，界面状态显示 `Loaded`、`Plugin Load Successful`；Photoshop 当前窗口可读到“生成填充”面板标签，但 Computer Use 的 Photoshop 截图捕获仍报 `SetIsBorderRequired 0x80004002`，无法安全驱动面板内控件，三文档切换 10 次真机验收仍未完成。
- 2026-07-30：补充活动文档枚举回归：`UxpPhotoshopRuntime.getOpenDocumentIds()` 以稳定 documentId 返回全部打开文档，不依赖文件名；PhotoshopGateway 定向测试 19/19、typecheck 通过。
- 2026-07-30 18:02：任务 0 重跑实际为 14 个测试文件、120/120、0 跳过；typecheck 与 `build:uxp`（含 UXP 校验）通过，保护目录摘要和 `git diff --check` 通过。
- 2026-07-30 18:02：按文档会话审计补强不可枚举 UXP 文档集合的安全语义：返回未知而非伪造单文档列表，避免误清理其他会话；同一文档轮询上下文无变化时不再制造无意义渲染，取消逻辑按 documentId+jobId 归属。
- 2026-07-30 18:02：新增 A/B 独立进度与取消回归、主机无法枚举文档时不伪造关闭列表回归；定向测试 2 文件/28 项通过。

- 2026-08-01：复现参考图上传失败：用 23KB 系统测试图直传 Litterbox 得到真实 HTTP 500，确认故障在临时图床、尚未进入心宝生成接口；增加 paste.rs HTTPS 图片地址自动回退。同步将“整图重绘”统一改为“图生图”，模型/分辨率下拉值与选项居中，主提示词框由 48px 增至 72px。定向测试 48/48、完整 Vitest 15 文件/160 项、typecheck、build:uxp/UXP 校验及 diff check 均通过。
- 2026-07-30：紧凑面板目标任务 0 复核通过：当前基线为 14 个测试文件、123/123 通过、0 跳过；typecheck、保护目录摘要与 diff check 通过。实施顺序为提示词本持久化浮层 → 局部选区状态灯 → 紧凑现代按钮与结果布局；最大风险是只改 UI 层时不破坏现有 UXP 文档会话、API Key secureStorage 与生成门控。
- 2026-07-30：提示词本已改为版本化 PromptNote，UXP 使用插件数据目录 JSON、浏览器使用 localStorage；支持搜索、模式筛选、新建/收藏当前、编辑、删除二次确认、置顶、拖放排序、快速填入和未保存编辑确认。局部重绘删除上下文卡片/独立比例卡片，改为模式栏下 22px 选区状态灯，生成前仍由现有真实门控拒绝无选区。
- 2026-07-30：按钮统一 140/180ms 动效、focus-visible、disabled 灰态和 reduced-motion；候选预览改为 contain；补回自定义宽比/高比输入。当前自动回归为 15 个测试文件、135/135 通过，typecheck、build、build:uxp/UXP 校验、280/310/360px 浏览器无横向溢出与保护目录摘要通过。
## 2026-07-30 提示词本独立页面与固定主操作
- 目标：提示词本彻底离开主配置 DOM，固定底栏始终可达，并把数量与空参考图压成高效控件。
- 顺序：基线与保护目录 → 红测隔离/边界 → 独立页面 → 固定底栏/步进器/参考图 → 主题与对抗审查。
- 最大风险：UXP 原生 select 穿透与固定底栏遮挡；必须用 DOM 隔离、滚动容器留白和窄面板证据共同验证。
- 任务 0：15 个测试文件、135/135 通过、0 skip/todo/only；typecheck、build:uxp（含 UXP 校验）和 diff check 通过。
- 红测证据：定向 UI 测试 23 项中 2 项按预期失败；旧实现仍保留底层生成按钮，且不存在数量减/加按钮。
- 绿测与自检：定向 UI 测试扩至 31/31；临时改错底栏类名后 1 项按预期失败，断言还原后继续验收。
- 真机加载：便携 Node 20.20.2 下 Adobe CLI 1.2.0 已对 Photoshop 27.8.0 完成当前 `uxp` 的 Validate + Load；未生成、未写回。
- 对抗审查第 1/3 轮：280/320/360px 无横向溢出；280×420 滚到底后内容与底栏间隔 8px；六主题、三模式、9 张参考图及提示词本隔离通过。
- 最终门禁：15 文件/145 测试/0 跳过；typecheck、build、build:uxp、UXP 校验、保护目录摘要、diff check 与最终产物 Adobe Validate + Load 全部通过。
- 2026-07-30 参考插件只读审查：釉光为 CEP/CEF（`CSXS/manifest.xml`），ELE.AI-PRO 为 UXP 宿主加本地 `<webview>`；两者的现代 CSS 都由 Chromium 渲染，不能作为纯 UXP CSS 等价证据。按“UXP 真机可靠性优先”继续保留本项目纯 UXP 架构，不改 manifest、依赖、API 或写回链路。
- 2026-07-30 真机约束视觉再校准：主配置改为有边界的紧凑卡片、强化模式选中态、11px 正文控件、深色输入面与 40px 固定主按钮；六主题继续复用主题变量。定向 UI 31/31，全量 15 文件/145 测试/0 跳过，typecheck、build、build:uxp/UXP 校验、保护目录摘要和 diff check 通过。
- 2026-07-30 最新产物已由 Adobe CLI 1.2.0（便携 Node 20.20.2）对 Photoshop 27.8.0 再次完成 Validate + Load，返回 `Manifest is validated successfully`、`Load command successfull`、`Plugin Load Successfull`；未点击生成、未写入当前 Photoshop 文档。
- 2026-07-30 补齐模式筛选、新建/收藏当前、Esc 未保存退出确认和返回滚动位置恢复的直接回归；滚动测试夹具先红 1 项，补齐 `window` 环境后定向 34/34。最终门禁为 15 文件/148 测试/0 跳过，typecheck、build、build:uxp/UXP 校验、保护目录摘要和 diff check 全部通过。
- 2026-07-30 Node 24 复核：系统 Node `v24.14.1`、npm `11.11.0`，项目 `npm install --dry-run --ignore-scripts` 返回 `up to date`；本项目依赖安装没有失败。Adobe UXP DevTools CLI 1.2.0 仍固定使用独立 Node 20，仅隔离 Adobe 旧安装脚本兼容性，不替换系统 Node。
- 2026-07-30 对抗审查第 2/3 轮：浏览器实际 DOM 在 280×420、320×600、360×600 下均为 `body.scrollWidth === body.clientWidth`、`panel.scrollWidth === panel.clientWidth`；280×420 滚到底时最后参考图区 bottom=352、固定底栏 top=362，保留 10px 间隔。提示词本打开时主配置 select=0、可见生成按钮=0，六套主题逐一切换后仍无横向溢出。
- 2026-07-30 本轮浏览器证据保存到 `C:\Users\Administrator\AppData\Local\Temp\ps-uxp-panel-evidence`：280×420 主配置、280×420 滚动到底、320×600、360×600、提示词本、局部重绘正常选区共 6 张；这些只证明浏览器渲染，不冒充 Photoshop UXP 真机截图。
- 2026-07-30 最终门禁复跑：`npm test -- --reporter=dot` 为 15 文件/148 测试/0 跳过；`npm run typecheck`、`npm run build`、`npm run build:uxp`（含 UXP verify）、`git diff --check` 全部通过；skip/todo/only 搜索无匹配。保护目录摘要仍为 `compact-panel-demo` 35 文件/`aa333f4b...e487`、`compact-panel-demo-v2` 4808 文件/`d83e11a3...b6d`。
- 2026-07-30 最新 `uxp/` 产物再次由 Adobe CLI 1.2.0 + Node 20.20.2 对 Photoshop 27.8.0 完成 Validate + Load，实际输出为 `Manifest is validated successfully`、`Load command successfull`、`Plugin Load Successfull`；未点击生成、未发起付费请求、未写入当前未保存 Photoshop 文档。
- 2026-07-31 用户提供三张真实 UXP 截图，覆盖文生图、整图重绘、局部重绘：提示词本入口、模式切换、固定全宽底栏和无选区门控均真实可见，但三种模式共同缺失“− 数量 +”步进器，仅留下“生成数量”标签。该真机证据否定了此前仅凭浏览器和静态 CSS 对步进器的通过判断。
- 2026-07-31 步进器真机兼容修复按两条独立红→绿回归完成：旧 UXP CSS 使用 `display:grid` 的测试先红，改为显式 Flex 后绿；旧 `<output>` 数值节点测试先红，改为普通 `<span role="status">` 后绿。最终全量为 15 文件/150 测试/0 跳过，`typecheck`、`build`、`build:uxp`/UXP verify 通过。
- 2026-07-31 最新产物已重新由 Adobe CLI 对 Photoshop 27.8.0 Validate + Load，输出 `Manifest is validated successfully`、`Load command successfull`、`Plugin Load Successfull`；Adobe 自动生成的范围外 `uxp/.uxprc` 已删除，未生成、未写回、未修改当前 PSD。
- 2026-07-31 用户新截图确认三种模式的数量步进器已在真实 UXP 恢复；同时发现窄宽模式文字被省略、顶部品牌重复、数量不能直输和卡片间距偏大。新增回归先红 2 项，随后删除内容区 AI/“生成填充”、模式按钮改为稳定三等分完整文案、步进器中心改为可直输并钳制 1–16，积分改为整数且 `auto` 显示为“自动选择”。
- 2026-07-31 本轮最终门禁：15 文件/153 测试/0 跳过；typecheck、build、build:uxp/UXP verify、diff check、保护目录摘要全部通过。最新产物再次对 Photoshop 27.8.0 Validate + Load 成功；自动生成的 `uxp/.uxprc` 已删除，未触发生成或 PSD 写入。
- 2026-07-31 完成任务书证据审计补强：参考图全局强度从 UXP 不稳定的 `<output>` 改为普通 `<span role="status">`，定向回归先红后绿；精简顶部后设置按钮以 `margin-left:auto` 保持右对齐，也完成红→绿断言。完整门禁仍为 15 文件/153 测试/0 跳过，typecheck、build、build:uxp/UXP verify、diff check和保护目录摘要通过；最新产物再次 Validate + Load 成功，未生成或写入 PSD。
- 2026-07-31 最新三张 UXP 真机图确认：原生模式按钮仍裁切中文、卡片高度压缩不足、数量输入默认宽度挤压 `+`。三组回归先红后绿后，模式切换改为 `role=tab` 的普通 span（支持点击、Enter、Space），删除模式外框；主配置改为扁平分区并将 UXP 提示词框锁为 48px；数量控件固定 92px，三段为 26/38/26px并清除输入默认外观。UI 39/39、全量15文件/153测试/0跳过，typecheck、build、build:uxp/UXP verify、diff check和保护目录摘要通过。
- 2026-07-31 上述扁平紧凑版已重新对 Photoshop 27.8.0 Validate + Load 成功，插件会话 `c584aa1b-7602-4207-9c1f-182a03b38c05`；自动生成的 `uxp/.uxprc` 已删除，未触发生成、费用或 PSD 写入。
- 2026-07-31 用户最新三模式真机图确认模式全文、顶部精简和扁平间距已生效，但固定 92px 数量控件仍被 UXP 文本输入框的宿主最小宽度挤压，`+` 仅剩黑色细条。新增“不裁切两端按钮”回归在旧 CSS 上按预期红 1 项，改为整列宽度、两端各 28px、中心自适应且父级不裁切后定向 39/39 变绿。
- 2026-07-31 280×685 浏览器几何复核：页面/面板均 `scrollWidth=clientWidth=280`；步进器 130.5px，`−/输入/+` 分别为 28/68.5/28px且全部可见。直接输入 12 生效，输入 16 后 `+` 禁用；该证据仅验证同源 Chromium 布局，不冒充 Photoshop UXP 真机外观。
- 2026-07-31 本轮完整门禁：15 文件/153 测试/0 跳过；typecheck、build、build:uxp/UXP verify、diff check和两套保护目录摘要通过。最新产物再次对 Photoshop 27.8.0 Validate + Load 成功；自动生成的 `uxp/.uxprc` 已删除，未生成、未收费、未写入 PSD。
- 2026-07-31 最终真机捕获再审：Photoshop 2026 正常响应，窗口从最小化安全恢复后像素捕获仍返回 `SetIsBorderRequired 0x80004002`；无障碍树只能确认“生成填充”宿主选项卡，不能读取 UXP 内部三段数量控件或证明其外观。未点击面板、未操作当前 `350924201904090020.jpg`，最新一步进器仍等待用户单张截图闭环。
- 2026-07-31 用户补交最新三模式 Photoshop UXP 真机图，最终确认文生图、整图重绘、局部重绘中的 `− / 4 / +` 均完整可见且不再裁切；模式全文、精简顶部、扁平分区、紧凑提示词框、无选区门控和固定底栏同时可见。最后一项真机外观缺口已解除。
- 2026-07-31 真机证据闭环后的最终复跑：15 文件/153 测试/0 跳过，typecheck、build、build:uxp/UXP verify、diff check、skip/todo/only 搜索和两套保护目录摘要全部通过；当前产物再次对 Photoshop 27.8.0 Validate + Load 成功，`uxp/.uxprc` 已删除，未生成、未收费、未写入 PSD，未创建 Git 提交。
- 2026-07-31 用户红框指出六处仍被忽略的无效纵向空白，并报告拖动面板宽度时闪烁。根因审计确认 UXP 宿主原生控件外边距未清零，同时 360px 媒体查询与自动滚动条槽会在调整尺寸时触发布局重算；新增间距/稳定几何回归在旧 CSS 上按预期红 1 项。
- 2026-07-31 修复后统一清零 UXP 控件与模块外边距，分区只保留 0–2px必要间隔；UXP 面板改为无条件占满宿主宽度并固定垂直滚动条槽。定向 UI 40/40；实际 `uxp/index.html + plugin.js + style.css` 在 280px 下测得红框对应间距 0–2px，在 280/320/360/361px 下分区纵坐标均保持 `[35,84,168,270,372]`，无横向溢出或 360px 临界跳变。
- 2026-07-31 空白/闪烁修复最终门禁：15 文件/154 测试/0 跳过，typecheck、build、build:uxp/UXP verify、diff check、skip/todo/only 搜索和保护目录摘要通过；最新产物已对 Photoshop 27.8.0 Validate + Load 成功，`uxp/.uxprc` 已删除，未生成、未收费、未写入 PSD。
- 2026-07-31 用户视频逐帧复现到约 2–3 秒和 9 秒的整块 UXP 面板半透明闪烁；因顶栏、内容和底栏同步透出桌面，排除单控件 React 重渲染，定位为宿主 resize 期间根绘制层透明合成。
- 2026-07-31 新增根层不透明与标题层级回归，旧 CSS 定向测试 2 项按预期红；修复后 `body/#root/舞台/面板` 四层均有不透明底色、UXP 面板取消大阴影合成层，分区标题升为 12px/700、模式正文 11px，定向 42/42 变绿。
- 2026-07-31 本轮完整门禁：15 文件/156 测试/0 跳过；typecheck、build、build:uxp/UXP verify、diff check、skip/todo/only 搜索及两套保护目录摘要通过。最新产物已对 Photoshop 27.8.0 Validate + Load 成功，自动生成的 `uxp/.uxprc` 已删除，未生成、未收费、未写入 PSD。
- 2026-07-31 用户第二段视频确认根背景修复无效；新视频中上下 resize 光标与整块面板重绘同步，前一轮“透明根层是根因”的判断被证据否定。改为监听原生 `resize`，拖动期间给面板加 `is-resizing` 并关闭内部 animation/transition，结束 160ms 后恢复。
- 2026-07-31 局部重绘提示词标题压为单行“提示词 可选”，完整“可留空，按上下文填充”移入 title；分区标题从 12px 提升到 14px/700，模式正文保持 11px/600；模型、分辨率、质量、数量值及参数标签居中。
- 2026-07-31 本轮新增视觉/resize 回归在旧实现上 3 项红，修复后定向 44/44；280px 实际浏览器几何为页面/面板 `280=280` 无溢出，局部标题 `67=67` 单行，参数值 computed `text-align:center`。
- 2026-07-31 本轮完整门禁：15 文件/158 测试/0 跳过，typecheck、build、build:uxp/UXP verify、diff check、skip/todo/only 与保护目录摘要通过；最新产物已对 Photoshop 27.8.0 Validate + Load 成功，`uxp/.uxprc` 已删除，未生成、未收费、未写入 PSD。
- 2026-08-01 修复参考图链路：整图快照改为最长边 3072px 的质量 9 JPEG，超过 1.8MB 时再降到最长边 2048px/质量 8；选区快照仍为 PNG。UXP Manifest 增加 `localFileSystem: "request"`，恢复本地文件选择器；Litterbox 故障时的备用上传从失效的 paste.rs 改为已用真实样片验证的 qu.ax 原图直链。完整门禁为 15 文件/164 测试，typecheck、build:uxp/UXP verify、diff check 与保护目录检查通过；Photoshop 真机重载与生成由用户验收。
- 2026-08-01 参考图上传二次纠偏：Photoshop 实测 qu.ax multipart 返回 400，且其所谓原图地址在无 Referer 时重定向到 HTML，确认不可作为心宝参考图 URL，已完全撤销。备用链路改为 Freeimage.host：先读取公开匿名上传令牌，再以 UXP 兼容的手工 multipart 上传；使用 `1M9A3529.jpg` 真实验证上传 200，返回地址无 Cookie/Referer下载为 200/image/jpeg/2,693,011 字节。完整门禁仍为 15 文件/164 测试，typecheck、build:uxp/UXP verify、diff check 与保护目录检查通过；未调用付费生图。
- 2026-08-01 完成参考图交互全链路修复：粘贴不再因提示词输入框聚焦而丢弃图片；拖放改用参考图区原生事件并兼容 `files` 与 UXP/Windows `items/getAsFile`；非图片不劫持拖放。UXP 本地选择器改成单一“全部文件”入口，选择后统一校验 PNG/JPG/WebP/GIF/BMP/AVIF。参考强度已从生产类型、状态和 UI 完全删除；缩略图新增 22px 右上角删除按钮并阻止冒泡，删除会撤销 Blob URL、重排顺序且允许同图重新添加，引用 ID 也改为跨批次唯一。新增回归后完整 Vitest 为 16 文件/168 测试，typecheck、build:uxp/UXP verify、diff check、调试残留及保护目录检查均通过；未调用上传服务或付费生图，Photoshop 真机粘贴/资源管理器拖入仍需 Reload 后验收。
- 2026-08-01 真机证据否定上一条对 UXP 拖放/粘贴可用性的判断：Adobe UXP 官方 Known Issues 明确普通面板不支持 Drag and Drop；Photoshop 画布持有焦点时 Ctrl+V 由宿主执行并新建图层，插件 DOM 收不到事件，UXP 剪贴板也不能可靠读取 Photoshop 图像内容。已删除误导性的 paste/drop 监听和“拖入、粘贴”文案，改为可靠的“本地图片 / 当前选区”双入口；“当前选区”直接通过 PhotoshopGateway 捕获 PNG，并按启动 documentId 加入对应会话，不经过剪贴板、不新增图层。文件选择器同步改用 Adobe 官方 `storage.fileTypes.images` 组合筛选。完整 Vitest 为 16 文件/167 测试，typecheck、build:uxp/UXP verify、diff check、误导文案/事件及调试残留扫描全部通过；未操作 Photoshop、未调用上传或付费生图。
- 2026-08-01 用户真机截图确认 `storage.fileTypes.images` 在 Windows UXP 中会被展开成 PNG/GIF/BMP/JPG 等独立下拉项，而不是一个“所有图片”组合项，否定上一条对选择器表现的假设。已改回只传 `{ allowMultiple: true }`、完全省略 `types`，使系统对话框直接显示所有文件；选中后仍由插件校验支持的图片格式。新增防回归断言，完整 Vitest 16 文件/167 测试、typecheck、build:uxp/UXP verify、diff check与构建产物扫描全部通过；等待用户 Reload 后确认 Windows 真机下拉已恢复为单一入口。
- 2026-08-01 用户真机截图确认参考图左下角两个黑块是 UXP 未稳定渲染箭头字形后残留的前后排序按钮。已彻底删除两个按钮，改为参考图缩略图内部鼠标拖动排序：按下后经过目标位置时中间项以 61px 平滑让位，松开或离开参考区时提交顺序；拖动项缩小、高亮并显示 grabbing 状态。删除控件同步从 22px 黑色方块改为 16px 半透明圆形小 `×`，悬停才红色提亮，并阻止触发拖动。完整 Vitest 16 文件/169 测试、typecheck、build:uxp/UXP verify、diff check、旧排序控件及调试残留扫描全部通过；等待用户 Reload 后真机确认鼠标事件与动效。
## 2026-08-14 UXP 输出控件不可点击修复
- 根因：`CenteredSelect` 在 UXP 中使用 `opacity: 0` 的绝对定位原生 `select` 充当透明点击代理；同时 `.field-row > span` 把同为 `span` 的下拉框外壳误压到 58px，导致显示层与真实命中层错位、原生焦点不可靠。
- 红证据：`npm test -- --run tests/uiWorkflow.test.tsx -t "keeps UXP output and parameter selects visible and hit-testable"` 为 1 项失败、56 项跳过，旧实现缺少 `field-row__label` 且没有 UXP 原生可见契约。
- 修复：两处输出标签改用 `field-row__label`；UXP 下拉框外壳占用剩余宽度，原生 `select` 改为 `position: static; opacity: 1`，仅在 UXP 隐藏装饰性的假文字和箭头。浏览器预览保持原居中外观；真机可用性优先于完全一致的视觉居中。
- 绿证据：同一定向用例 1/1 通过；`tests/uiWorkflow.test.tsx` 57/57 通过；`npm run typecheck` 退出 0；`npm run build:uxp` 通过（50 modules，`uxp/style.css 39.23 kB`，`uxp/plugin.js 314.47 kB`，UXP verify 通过）。
- Photoshop 27.8.0 真机 Load 成功，会话 `fe784d94-bd04-4f07-95e8-b64f4565b6b1`。5 个下拉框实测均为 `opacity=1`、`position=static`、高度 29px；两处输出外壳由旧 58px 扩为 192px。逐点几何审计未发现覆盖层，中心点可命中元素均为对应 `select`/数量按钮本身。
- 当前生成数量为上限 4，因此 `+` 按钮按契约禁用（opacity 0.43），`-` 按钮启用；未触发生成、付费请求或 Photoshop 文档写回。
- 调试中 Photoshop 的退出经用户确认是其主动关闭，非插件崩溃；重启后为空白主页，未执行文档恢复。

## 2026-08-14 云端缩略图懒加载修复
- 生产缺口复现：心宝列表记录不含结果 URL 时 UI 只显示“无缩略图”，Hook 不调用详情接口；已有 URL 的缓存调用实际为 `fetch(url, { signal: undefined })`，会触发 UXP 宿主 `addEventListener` 异常。
- 红证据：三文件定向回归为 2 failed / 1 passed；UI 找不到“加载缩略图”按钮，Hook 无法进入图片 ready；缓存单测精确显示收到多余 `{ signal: undefined }`。
- 修复：成功任务即使列表无 URL 也提供懒加载入口；点击后只调用 `GET task.xinbao-ai.com/api/v1/tasks/{taskId}` 补全结果，再下载图片，生成 POST 为 0。API Key 仅在详情请求 Authorization 头。
- 缓存无 signal 时调用 `fetch(url)`，有 signal 时才传 `{ signal }`；同 taskId 详情/图片请求去重，关闭页面、Key/Base URL 变化、连接重测及组件卸载均 abort 请求并释放 Blob URL。
- 绿证据：`cloudTaskImageCache + uiWorkflow + usePrototypeState.integration` 定向 4/4 通过（67 项未选中，不是 skip 标记）；详情补全后 `thumbnailUrl` 写回当前临时记录，页面卸载断言 Blob URL 已 revoke。
- 相关文件完整回归 3 文件/71 测试全部通过，`npm run typecheck` 退出 0；`npm run build:uxp` 通过（50 modules，`style.css 39.23 kB`，`plugin.js 315.39 kB`，UXP verify 通过）。本次仍不是第四轮完整五门禁验收。
- 零费用 Photoshop 27.8.0 真机复核通过（UXP 会话 `448e5424-619a-4f4a-abb9-ee99e150cffd`）：生产云端页先 `GET https://task.xinbao-ai.com/api/v1/tasks?limit=100` 返回 200，再对既有 `img_7v2dfybbmw2gic3s` 发送唯一详情 GET；约 30 秒后详情返回 200，页面显示 `blob:/blob-1` 缩略图。
- 真机请求审计未使用 `Response.clone()`，生成 `/v1/images/generations` POST 数为 0；其余请求仅为插件既有余额 GET。关闭云端页后 DOM 页面消失，并实测调用 `URL.revokeObjectURL("blob:/blob-1")`，没有长期保存图片或写入 Photoshop 文档。

## 2026-08-14 设置记忆 Photoshop 正常重启验收
- 在 `%TEMP%\ps-fill-settings-restart-20260814.png` 专用 512×512 PNG 上确认“记忆最后设置”开关为开启；文件 SHA256 为 `F8775C7E8717CB4067B50269A6A6233191B3186A72977688664B211D307DF5D6`，无用户文档参与。
- 文生图数量从真实持久化基线 `1` 改为 `3`，等待持久化后调用 Photoshop 主窗口正常关闭；输出 `CloseMainWindow=True`、`PHOTOSHOP_EXITED_NORMALLY`，未强杀进程。
- 重启 Photoshop 27.8.0、重新打开同一临时 PNG并 Load 当前 UXP，会话 `25e32b81-33c4-4031-aeae-7c104e19e5a4`；生产 DOM 实测模式仍为“文生图”、数量恢复为 `3`，证明跨 Photoshop 进程记忆生效。
- 验收后数量恢复为原基线 `1`，临时文档通过 `closeWithoutSaving()` 关闭，源 PNG 已删除；Photoshop 留在空白主页。全程生成 POST 为 0，无费用、无 Photoshop 写回。

## 2026-08-14 强制终止残留清理与局部重绘单图直写
- 使用专用 `%TEMP%\ps-fill-inpaint-direct-20260814.png`（768×768，SHA256 `9BE93B95C776A061129792582A617F81BA8E3F95A9EF4EE8A2366CE038F8A63C`），无用户文档。一次 CDP 异步 modal 调试遗留宿主模态；UXP 正常 unload 成功但 Photoshop 正常关闭仍被阻止，在确认仅有无 `*` 临时 PNG 后强制结束 PID 31112。
- 重启 Photoshop 后最新 UXP Validate + Load 成功（会话 `0dcb9bd8-40af-4e05-af86-0765381ea581`）；启动扫描后 UXP 临时目录总条目 0、`ps-fill-*` 条目 0，临时文档插件图层 0、插件通道 0，证明本次安全强制终止后的残留被补清。
- ComfyUI 0.28.0 由既有安装以隐藏进程 PID 7832 启动，`/system_stats` 在线；未修改其目录或模型。局部重绘选区精确为 `(320,330)-(448,458)`，空提示词、9B Distilled、数量 1，生产状态显示“选区已读取”。
- 真机生成链：`system_stats`/`object_info` 200，3 个插件上下文/遮罩上传 200，唯一 `/prompt` POST 200，约 50 秒后 `/view` 200。远程 `/v1/images/generations` POST 数为 0；生成中插件选区通道为 1，完成后为 0。
- 数量 1 未进入候选页，直接新增正式“智能填充”层；图层数 1→2，结果层可见、opacity 100、blendMode normal，边界精确 `(320,330)-(448,458)`，选区已清理。该证据证明局部重绘单图直写与资源清理，不冒充文生图/图生图付费链。

## 2026-08-14 文生图当前文档、账户闸门与真实写入恢复
- 专用 A/B 文档均为 768×768 临时 PNG：A SHA256 `F713737DA907455FACA4B4E43D8FD15B546B80CAB53F1E65F93FCD3820A8FD29`，B SHA256 `986DE4C2634C5F78BD35EE242198A44330455B619CFD85D6BAF0B039B4BBB1ED`；无用户文档。
- A 使用文生图、当前文档、数量 1、1K/low，唯一 `POST https://async.xinbao-ai.com/v1/images/generations` 返回 202；后续轮询仅走 `POST /v1/tasks/batch-get`。生成期间切换到 B并真实新增 `Acceptance edit during generation` 图层，Photoshop 可继续编辑。
- A 仍生成时，在 B 输入第二提示词并点击启用的生成按钮，UI 明确提示“已有一个付费远程任务正在运行，请等待完成后再试”；生成 POST 总数严格保持 1，无静默排队。
- A 结果图片 GET 200 后活动文档仍为 B，生产写入因文档身份不符自然失败；切回 A显示“图片已生成，重试写入 / Photoshop 写入失败”，A 原图层仍仅 1 层，生成字节保留在文档会话。
- 点击真实“重试写入”后 A 图层数 1→2，正式层 opacity 100；恢复前后生成 POST 都为 1，未再次调用生成接口。积分 3065→3053，对应唯一云端 taskId `img_kpdowbbln6e25fu3`，状态 succeeded、标记“本插件提交”。

## 2026-08-14 新建文档真机失败与 modal 契约修复
- 第二个真实文生图任务使用数量 1、输出“新建文档”，唯一生成 POST 202、结果 GET 200、积分 3053→3041；但 Photoshop 文档数保持 2并进入写入恢复，证明旧实现未通过新建文档真机验收，生成结果仍在会话中且未重复 POST。
- 真机反证并修正根因：`app.open()` 放在 modal 外会被 Photoshop 27.8.0 明确拒绝；已付费结果文件若先写好，再执行 `executeAsModal → app.open()` 则立即成功创建文档 98。正确边界是临时文件在 modal 外写完，随后在内部 modal 执行 `open + 改名/置入`。
- 第一组红→绿：旧实现顺序为 `write, open, modal`，新测试要求真机契约 `write, modal, open` 后 1 项按预期变红；实现修正后 PhotoshopGateway 31/31 通过。
- 最新构建 Load 后，第三个文生图“新建文档”任务唯一生成 POST 202、积分 3041→3029；初次写入进入恢复页，随后同一结果在不增加生成 POST 的真实“重试写入”中成功创建 Photoshop 文档 113，证明结果复用与新建文档路径生效。
- 真机检查发现文档 113 仍为锁定“背景”层；根因是改名 Action Manager 使用 `synchronousExecution:false` 提前返回。第二组红→绿先精确收到 false 而失败，改为 true 后 PhotoshopGateway 31/31；已有零费用真机同步 batchPlay 证据显示图层改名与 opacity 100 均生效。
- 为避免修复重载丢失本次已付费结果，重载前从原结果 URL 正常下载 `8,458,844` bytes到 UXP 临时文件 `codex-paid-newdoc-result-20260814.png`；文件不使用 `ps-fill-` 清理前缀，不含 Key或提示词。

## 2026-08-14 图生图单图直写真机验收
- A 文档建立 `(40,40)-(728,728)` 专用选区，图生图“当前选区”真实截取后面板显示 `参考图 1/9` 和 1 个 Blob 预览；数量 1、1K/low、当前文档输出。
- 参考上传后唯一 `POST https://async.xinbao-ai.com/v1/images/generations` 返回 202，轮询只访问 `/v1/tasks/batch-get`；约 90 秒后面板显示“图片已生成并写入 Photoshop”，A 图层数 `2→3`，正式层使用提示词命名。
- 积分 3029→3017；清空参考图后 DOM Blob 图片 `1→0`，UXP 临时目录 `ps-fill-*` 为 0，A 文档插件选择通道为 0。该项不冒充 2～4 候选预览验收。

## 2026-08-14 双候选单预览层与用户层安全修复
- 首个数量 2 任务只提交 1 个生成 POST，返回 2 个候选共 `2,390,869 + 2,424,484` bytes，积分 3017→2993；面板活动 Blob 为 2。方案切换 id `4→5→7` 时 Photoshop 始终仅有 1 个候选预览层，边界均为 `(0,170)-(768,598)`；返回配置后两 Blob均 revoke、预览层归零。
- 真机同时发现严重安全回归：B 的普通用户测试层 id 3 被 `placeEvent` 替换。红测精确复现为文档层 `[4,2]` 不再包含用户层 3；仅调整“新层 ID 判定”仍不足，第二个数量 2 任务（仍仅 1 POST，积分 2993→2969）继续删除 sentinel id 8。
- Action Manager 裁决根因：`placeEvent` 对当前空层返回 `replaceLayer.from=10 → to=11`，即 Photoshop 会直接替换用户活动空层。修复改为先创建唯一 `ps-fill-place-anchor-*` 插件锚点，再让 `placeEvent` 只替换该锚点；失败时也只按锚点 ID/专用名清理。
- 红→绿：新增“用户层仍存在”测试旧实现按预期失败，收到层 `[4,2]`；锚点实现后 PhotoshopGateway 32/32。真机零费用复核中 anchor id 13 被准确替换为候选 id 14，用户 sentinel id 12 与原图 id 2 均保留；切换候选时 anchor id 15→候选 id 16，仍为候选 1 层 + sentinel 1 层 + 原图 1 层，候选边界不变。
- 最终定向门禁：PhotoshopGateway、PreviewCoordinator、AssetLifecycleManager、真实 Hook 共 4 文件/47 项通过；typecheck 退出 0；`build:uxp` 50 modules，`style.css 39.23 kB`、`plugin.js 316.51 kB`，UXP verify 与 Photoshop 27.8.0 Validate + Load 均通过。
- 收尾：三个一次性 Photoshop 文档均无保存关闭，宿主文档数 0；UXP 临时目录中的 `ps-fill-*`、两张已付费候选副本和新文档审计副本全部删除，最终 owned temp 0、DOM Blob 0，生成测试源未包含用户文档。
- 无文档最终复核：主界面正确门控“请先打开 Photoshop 文档”；提示词本真机显示 6 条自动历史，包含本轮 4 条文生图和 1 条图生图成功提示词且与 3 条手工收藏分页隔离。最终 `git diff --check=0`、保护目录检查=0，哈希仍为 `aa333f4b...e487` / `d83e11a3...b6d`，`uxp/.uxprc` 已删除。
## 2026-08-18 Remove Local Inpaint
- Goal: retain text-to-image, whole-image redraw, and ordinary reference images only.
- Baseline: current 19-file worktree removes local inpaint/Klein code; typecheck passes.
- Order: remove dedicated tests, update shared tests, rebuild UXP, run offline gates.
- Risk: shared tests may still encode local selection/mask behavior; selection reference capture must remain.
- Boundary: no Photoshop, ComfyUI, recovery-copy, or API-key operation; no Git commit.

## 2026-08-19 Local Inpaint Removal Verification
- Removed only the local inpaint/Klein/ComfyUI path: local provider, geometry/mask snapshot and writeback, selection-channel cleanup, local settings, and their dedicated tests/docs.
- Kept remote text-to-image, whole-image image-to-image, local reference uploads, Photoshop selection screenshots as references, cloud records, balance, prompt history, candidate preview, and Photoshop layer/document writing.
- Offline gates: `npm test` 25 files / 208 passed / 0 skipped; `npm run typecheck` passed; `npm run build:uxp` passed (49 modules); `npm run verify:uxp` passed; `git diff --check` passed.
- Static scan found no local-inpaint/Klein/ComfyUI references in `src`, `uxp`, `README.md`, `docs`, or tests. Photoshop real-host validation was intentionally not run.
- The protected-directory check remains independently blocked because the historical `compact-panel-demo` and `compact-panel-demo-v2` directories are absent; no placeholder directories were created.
- 2026-08-19 UI 修复：`ModeTabs` 改为真实 `button[role=tab]`，一次点击图生图调用 `updateDraft({ mode: "redraw", outputTarget: "current-document" })`；保留 Enter/Space 键盘路径且不触发生成。
- 主面板修复：自定义 UXP 下拉 wrapper 参与字段行 flex 宽度；参考图空状态保持双按钮横排；清空/提示词本统一高度、边框、hover/focus/disabled；设置正文和按钮字号提升。
- 设置页修复：模型能力区显示真实模型数量、能力来源和 fetchedAt 时间；设置滚动改为 `auto`，刷新模型/测试连接按钮保留在可见的双列操作区；未恢复局部重绘设置。
- UI 专项测试 `tests/uiWorkflow.test.tsx`：60/60 通过，覆盖一次点击、键盘激活、按钮类型、模式顺序、窄面板 CSS 和模型能力展示。
- 全量验收：`npm test` 25 文件/213 通过/0 跳过；typecheck、UXP build、UXP verify、git diff --check、impeccable detect 均通过；UXP 49 modules，style.css 37.42 kB，plugin.js 283.12 kB。
- 静态核验：源码无 `span role="tab"`；skip/todo/only 扫描干净；生成产物包含 mode-tab、settings-secondary-actions 和真实下拉 DOM。
- `node scripts/check-protected-dirs.cjs` 仍因历史 `compact-panel-demo`、`compact-panel-demo-v2` 缺失失败；未伪造目录、未修改脚本。Photoshop 真机单击切换/设置页可见性尚未执行，未操作当前文档。
# 2026-08-19 当前会话核验
- 目标：仅交付 `D:\ps fill plug-in`，保留历史功能；不操作 Photoshop 当前文档、不读取或输出 API Key。
- 实际路径差异：`D:\ps fill plug-in-replay-phase4-archive`、phase2 archive 及截图中的其他恢复副本当前均不在 D 盘根目录，无法作为可读恢复源。
- 实际门禁基线：`npm ci` 成功（103 packages）；`npm test` 为 25 文件/213 测试/0 skipped；`npm run typecheck`、`npm run build:uxp`、`npm run verify:uxp`、`git diff --check` 均通过。
- 最大风险：测试总数低于用户要求的 259，且 `node scripts/check-protected-dirs.cjs` 因缺失 `compact-panel-demo` 与 `compact-panel-demo-v2` 失败。
- 当前决定：不伪造缺失目录、不修改保护脚本、不宣称完成；保留现有正式目录修改并提交可复现状态，等待真实恢复源或用户确认。
# 2026-08-19 UI 目标续验
- 源码与回归：`ModeTabs` 使用真实 `button[role=tab]`，两个 tab 顺序为文生图、图生图；单击图生图测试真实断言 `updateDraft({ mode: "redraw", outputTarget: "current-document" })`，键盘激活也通过。
- 离线门禁：`npm test` 25 文件/213 测试/0 skipped；`npm run typecheck`、`npm run build:uxp`（49 modules）、`npm run verify:uxp`、`git diff --check`、impeccable detect 均通过。
- 产物核查：`uxp/plugin.js` 含 `mode-tab`、`settings-secondary-actions`、刷新模型/测试连接文本；`uxp/style.css` 含两个自定义下拉宽度规则；manifest 为 UXP v5 且权限完整。
- 只读真机观察：UXP Developer Tools 显示 `com.codex.generative-fill` 为 `Loaded`，Photoshop 返回“生成填充”面板选项卡；未点击 Reload/Unload，未操作当前文档，未读取 API Key。
- 真机阻塞：Photoshop 画面捕获仍返回 `SetIsBorderRequired failed: 不支持此接口 (0x80004002)`，因此无法提供 320px 面板视觉/点击证据，不宣称真机验收通过。
# 2026-08-19 真机截图反例修复
- 用户提供的 Photoshop 截图确认两个实际问题：长下拉仍被 `body.uxp-shell .field-row > span`/窄屏媒体规则压成约 58px；设置页因 `UxpDropdownProvider` 包装层导致 `> .plugin-panel` 选择器失效，主面板内容透出并覆盖 API Key 区域。
- 修复：仅将标签选择器收窄为 `.field-row__label`，为 UXP wrapper 增加最终 flex/width 规则；设置页改用 `.prototype-stage.settings-is-open .plugin-panel` 隐藏被包装的面板。
- 回归：本地 320px DOM 几何中长下拉宽度为 223px；设置页 `plugin-panel` 为 `display:none`，刷新模型/测试连接按钮分别约 137x30px 且可见，API 输入框不再重叠。
- 门禁：`npm test` 25 文件/213 测试/0 skipped；`npm run typecheck`、`npm run build:uxp`、`npm run verify:uxp`、`git diff --check`、impeccable detect 均通过。
# 2026-08-19 产物最终复核
- 当前提交 `031ee0f` 工作树干净；重新执行 `typecheck`、`npm test`（25/213/0 skipped）、`build:uxp`（49 modules）、`verify:uxp`、`git diff --check`、impeccable detect，全部通过。
- `skip/only` 扫描为 0 matches；UXP 产物已由最新源码重建。
- `node scripts/check-protected-dirs.cjs` 仍因正式目录缺失 `compact-panel-demo` 首项失败；未创建伪造目录、未修改保护脚本。
- Photoshop 当前仍有带未保存标记的用户文档，且未重新加载最新产物；真机 320px 单击切换和设置页视觉复核等待用户在安全时机手动 Reload 后提供证据。
# 2026-08-19 UXP 数量控件层叠修复
- 用户截图复现：打开自定义下拉菜单时，数量的原生 UXP `input` 绘制在菜单上方；此前为避免输入框最小宽度裁剪而设置的 `overflow: visible` 放大了该问题，且原生输入的文本居中不稳定。
- 修复：浏览器演示仍保留直接输入；UXP 改为只读静态数字，数量继续通过真实 `-/+` 按钮调整。步进器恢复 `overflow: hidden` 并隔离层叠上下文，静态数字通过 flex/text-align 居中。
- 回归：新增 UXP 静态数字、无原生输入和裁剪层叠上下文断言；`npm test` 25 文件/214 测试/0 skipped，`typecheck`、UXP build/verify、diff check、impeccable detect 均通过。
- 真机边界：未 Reload/Unload、未操作当前 Photoshop 文档；新版产物等待用户在安全时机加载后复核下拉菜单与数量控件。
# 2026-08-19 UXP count stepper menu bleed follow-up
- Completed: UXP count now renders as a centered static span; browser mode retains direct numeric entry. This prevents native UXP input paint from appearing above dropdown menus.
- Completed: regression coverage proves the UXP static value, clipping/isolation, browser entry, and one-click `ModeTabs` redraw transition.
- Validation: `npm run typecheck`, `npm test` (25 files, 214 passed, 0 skipped), `npm run build:uxp` (49 modules), `npm run verify:uxp`, `git diff --check`, and impeccable detection all passed.
- Blocked: `node scripts/check-protected-dirs.cjs` fails because `compact-panel-demo` is absent. No placeholder directory or script change was made.
- Next: user reloads the current `uxp/manifest.json` build only when safe, then confirms at about 320px that count text stays centered and does not cover opened output-ratio/resolution menus. Do not generate, read an API key, or alter the Photoshop document.
