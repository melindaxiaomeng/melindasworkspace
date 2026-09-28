# SaaS 客户需求与 Bug 自动化协同系统 — 落地拆解方案

> 本文档基于现有 `kanban-pool`（需求与问题池看板）的真实代码盘点，对照 PRD 标注 P0/P1 缺口、给出分阶段改造步骤与排期。
> 定位：**这是现有看板的"二期升级"**，不是从零新建。大量能力已具备，真正增量集中在"抓取层 + AI 入库提取 + 个人工作台视图"。

---

## 一、现状盘点（代码核实，2026-09）

### 1.1 已具备的能力
| 能力 | 实现位置 | 说明 |
|---|---|---|
| 看板四列 | `public/index.html` `STATUS_ORDER = ['inbox','this_week','in_progress','done']` | 对应 PRD 收件箱/待做/处理中/已完成 |
| 卡片字段 | `server.js` `normalizeItem` + `POST /api/items` | `summary/source/priority(高·中·低)/status/person/attribution/dateStart/dateEnd/result/images/note` |
| AI 能力 | `server.js` `/api/ai/diagnose`、`/api/ai/summarize`、`/api/ai/report` | 已接 DeepSeek（`callLLM`），含 `AI_MOCK` 与 TF-IDF 兜底 |
| 报告 | `reports.json` + 日报/周报 Tab | 已支持生成与删除 |
| 鉴权 | `API_TOKEN` Bearer | 全局 `/api/` 自动生效 |
| 部署 | Docker `node:22-alpine` + compose + nginx 反代 + Cloudflare | `workspace.teensing.com:3777` |

### 1.2 现有字段 vs PRD 字段映射
| PRD 字段 | 现有对应 | 状态 |
|---|---|---|
| `title` | `summary` | ✅ 等同（标题/摘要） |
| `source` | `source` | ✅ |
| `priority` 高/中/低 | `priority` 高/中/低 | ✅ |
| `status` | `status` | ✅ |
| `result_note` | `result` | ✅ |
| `assignee`(责任人) | `person` | ✅（缺"按人过滤视图"） |
| `note`(长文本) | `note` | ✅ |
| `raw_message`(原始聊天) | 无 | 🆕 |
| `category`(功能Bug/新需求/接口异常) | 无 | 🆕 |
| `module`(DMP/SAAS/支付…) | 近似 `attribution`(自由文本) | 🆕 新增枚举 |
| `reporter`(提报人) | 无 | 🆕 |
| `ai_analysis` | 现有为点按钮实时生成（`ai-box`），未落库 | ⚠️ 需改为"入库即提取并存储" |

---

## 二、三个必须先拍板的决策（附推荐）

### 决策 1：技术栈 —— 推荐 **继续 Node.js 扩展，不引入 Python**
- PRD 示例是 Python FastAPI，但现有系统是**零依赖 Node.js**，已接好 DeepSeek、已部署 Docker/compose/nginx。
- FastAPI 示例里 `BOARD_API_URL` 直接调我们现有 `POST /api/items` 即可，无需独立服务。
- 重写 Python 会双栈维护、部署翻倍，风险高。**抓取层用 Node 起同样的 webhook 接收路由即可。**

### 决策 2：抓取渠道 —— 推荐 **先做"手动贴聊天 → AI 提取"过渡形态，再接机器人**
- 飞书全量订阅、企微进群回调都是**纯外部运维活**（注册应用、OAuth、配群权限、验证可达性），最慢且最不可控。
- AI 洗包的**准确度**才是真正风险点。先用"粘贴一段群聊 → 自动提取结构化卡片"验证准确率，再投入接机器人，性价比最高。

### 决策 3：个人工作台形态 —— 推荐 **同一看板 + 按 `person` 过滤视图**
- 数据本就一份，无需独立看板。"团队总池 / 个人工作台"只是顶部的视图开关：
  - 团队总池：展示全部
  - 个人工作台：`person === 当前用户` 过滤
- "当前用户"识别：MVP 用 `localStorage` 存一个"我是谁"下拉（选已知 `person`），不建完整多用户账号体系。

---

## 三、P0 / P1 缺口清单

### P0（二期价值必做）
| 缺口 | 类型 | 改造点 | 代码级建议 |
|---|---|---|---|
| 新增字段 `rawMessage` | 数据模型 | `normalizeItem` 补默认 `''`；`PUT` 的 `allowed` 加 `rawMessage` | 落库原始聊天，便于回溯 |
| 新增字段 `category` | 数据模型 | `normalizeItem` + `allowed` 加 `category` | 枚举：`功能Bug`/`新需求`/`接口异常`/`操作咨询` |
| 新增字段 `module` | 数据模型 | `normalizeItem` + `allowed` 加 `module` | 枚举：`DMP`/`SAAS系统`/`数据报表`/`支付结算`/`网盟Mapping`/`其他` |
| 新增字段 `reporter` | 数据模型 | `normalizeItem` + `allowed` 加 `reporter` | 提报人/客户名 |
| `aiAnalysis` 落库 | 数据模型 | `normalizeItem` + `allowed` 加 `aiAnalysis` | 入库即提取并存储，而非仅实时生成 |
| **AI 入库提取接口** `/api/ai/extract` | AI | 复用 `callLLM`，新增 prompt：输入原始文本 → 输出 `{is_need,title,category,module,priority,ai_analysis}` JSON | 解析失败时回退 `is_need:false` 或 `category:其他` |
| **抓取接收路由** `/api/ingest` | 后端 | `POST` 接收 `{text,source,reporter}` → 调 `/api/ai/extract` → `is_need` 则建卡片（带 `rawMessage/reporter/category/module/aiAnalysis`） | 复用现有建卡逻辑 |
| **个人工作台视图** | 前端 | 顶部"团队总池/个人工作台"开关 + `person` 过滤；`localStorage` 存当前用户 | 低代码量，高价值 |

### P1（增量增强）
| 缺口 | 类型 | 说明 |
|---|---|---|
| 手动贴聊天入口 | 前端 | 一个文本框"粘贴群聊 → 提取并预览 → 确认入池"，用于过渡期验证 AI 准确度 |
| 分类/模块筛选器 | 前端 | 顶部加 `category`、`module` 下拉过滤 |
| 卡片展示 `category`/`module` 标签 | 前端 | 在 `meta` 区加彩色标签，便于一眼区分 Bug/需求/模块 |
| AI 提取 prompt 调优 | AI | 针对误判（闲聊当需求 / 需求当闲聊）迭代 few-shot 示例 |
| 抓取层双渠道接入 | 运维 | 飞书 `im:message` 全量订阅、企微应用回调，按决策 2 排期后置 |
| 看板列标签对齐 PRD | 前端 | 列标题可按 PRD 改为"收件箱/本周待做/处理中(观察中)/已完成" |

---

## 四、分阶段改造步骤

### Phase 0 — 数据模型与提取内核（0.5 天，后端）
- `server.js`：`normalizeItem` 补 `rawMessage/category/module/reporter/aiAnalysis` 默认 `''`；`PUT allowed` 同步扩充。
- 新增 `/api/ai/extract`（复用 `callLLM` + JSON 解析 + 失败回退）。
- 验证：用 curl 直接打 `/api/ai/extract` 看返回结构。

### Phase 1 — AI 洗包内核 + 过渡入口（1 天，后端 + 前端）
- 新增 `/api/ingest` 落库路由。
- 前端加"粘贴群聊 → 提取预览 → 确认入池"入口（P1 手动入口提前做，用于校验 AI 准度）。
- 卡片 `meta` 区加 `category`/`module` 标签展示。

### Phase 2 — 双层看板协同（1 天，前端）
- 顶部"团队总池 / 个人工作台"视图开关。
- 个人工作台 = `person === 当前用户`；`localStorage` 存"我是谁"。
- 顶部加 `category`/`module` 筛选下拉。
- 看板列标题对齐 PRD 命名。

### Phase 3 — 渠道接入（1.5 天，运维 + 后端）
- 飞书：开放平台开 `im:message` 全量订阅，机器人拉群，事件回调转发到 `/api/ingest`。
- 企微：应用消息回调，群消息转发到 `/api/ingest`。
- 后端 `/api/ingest/feishu`、`/api/ingest/wecom` 做签名校验后复用统一 ingest 逻辑。
- 加 IP 白名单 / 签名校验防伪造。

### Phase 4 — 联调与准确率调优（0.5 天，全员）
- 模拟群聊消息，验证"无感抓取 → AI 过滤 → 落池 → 派单 → 个人看板联动"全链路。
- 汇总 AI 误判样本，迭代 `extract` prompt。

---

## 五、排期汇总（合计 ≈ 4.5 天，与 PRD 估算一致）

| 阶段 | 内容 | 工时 | 依赖 |
|---|---|---|---|
| Phase 0 | 字段扩充 + `/api/ai/extract` | 0.5d | 决策 1（Node） |
| Phase 1 | AI 洗包内核 + 手动贴聊天入口 | 1d | Phase 0 |
| Phase 2 | 个人工作台视图 + 筛选 | 1d | Phase 0 |
| Phase 3 | 飞书/企微渠道接入 | 1.5d | 决策 2；运维配置 |
| Phase 4 | 联调 + prompt 调优 | 0.5d | Phase 1~3 |

---

## 六、风险与验证

| 风险 | 等级 | 缓解 |
|---|---|---|
| AI 提取误判（闲聊当需求 / 需求当闲聊） | 高 | Phase 1 先用"手动贴聊天"收集真实样本迭代 prompt，再接机器人 |
| 抓取渠道审批/配置卡壳（飞书/企微权限） | 中 | 决策 2：机器人后置，先用过渡入口跑通业务流 |
| 双栈维护（Node + Python） | 中 | 决策 1：坚持 Node 单栈 |
| 个人工作台"当前用户"识别 | 低 | MVP 用 `localStorage` 下拉，不建账号体系 |

**验收方式**：每个 Phase 结束用 curl + 浏览器实测（参考此前备注展开 bug 的排查经验——改交互先查 CSS 跨组件污染，再查 JS 事件）。

---

## 七、决策定稿（2026-09-28 用户拍板）

用户已确认以下三项，**推翻了原文档里的两个推荐**：

| # | 议题 | 定稿 |
|---|---|---|
| 1 | 技术栈 | **继续 Node.js 单栈**（不引 Python）。PRD 示例里的 FastAPI 仅作参考，`POST /api/items` 即可作为落库入口。 |
| 2 | 抓取渠道 | **直接上机器人**（飞书/企微 webhook），不做"手动贴聊天→AI 提取"的过渡形态。 |
| 3 | 个人工作台 | **每个人登录后看「自己的 + 团队总池」双视图**，同一看板按 `person` 过滤。 |

### 已实现的对应改动（按定稿推进）

- **字段补全**（已完成，commit `1f77f69`）：`rawMessage`/`category`/`module`/`reporter`/`aiAnalysis` 已落地（`server.js` 默认值 + `POST`/`PUT` 白名单；`public/index.html` 编辑弹窗 + 卡片徽标）。
- **登录身份 + 双视图**（已完成，commit `1f77f69`）：登录弹窗增加「你的名字」→ 存 `localStorage`；header 增加「团队总池 / 我的看板」切换；「我的看板」按 `person===当前用户` 过滤；新增条目默认责任人为当前用户。
- **机器人接入**（已完成，本批）：`server.js` 新增 `POST /api/ai/extract`（复用 `callLLM` 结构化提取）、`POST /api/ingest`（通用）+ `/api/ingest/feishu` + `/api/ingest/wecom`（原生事件适配），`INGEST_SECRET` 二次鉴权；详见 `docs/机器人接入.md`。

### 仍待用户侧完成的外部依赖（无法在代码内解决）

1. 飞书开放平台：创建企业应用、开 `im:message` 权限、配置事件回调 URL、处理 `url_verification` 挑战。
2. 企微：自建应用、`CorpID/AgentId/Secret`、消息 AES 解密、回调 `echostr` 校验。
3. 建议用一个**轻量转发脚本**做签名校验 + 解密 + 挑战应答，再把明文 POST 给 `/api/ingest*`（带 `API_TOKEN` + `INGEST_SECRET` 两个头）。
