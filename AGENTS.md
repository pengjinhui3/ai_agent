# 项目协作要求（ai_app）

## 动态配置优先原则

- **凡是可能需要经常调整的运行时参数**（超时、上限、预算、开关、阈值等），**一律写入 `ai_sys_config` 动态配置表**（内置键标 `is_builtin=1`），严禁在代码中硬编码常量。
- 已入表的内置键（持续维护）：`tool_result_max_chars`（工具结果截断）、`mcp_request_timeout_seconds`（MCP 请求超时）、`mcp_init_timeout_seconds`（MCP 初始化超时）、`text_inject_max_chars`（文本附件注入上限）、`agent_max_steps`（Agent 工具循环步数上限）、`anthropic_max_tokens`（Anthropic 协议默认 max_tokens）、`memory_summary_trigger_chars`（记忆摘要触发水位线）、`task_result_max_chars`（任务结果截断长度）、`base_model_id`（系统基础模型，兼摘要模型）、`skills.max-chars`（技能注入预算）、`thinking_effort` 字典（思考档位）。
- 新增动态参数的接入三件套：① DB 预置行（is_builtin=1 + 合理默认值）；② 后端读取辅助（缺省/非法/DB 异常回退默认值，不得让对话主流程因配置问题失败）；③ `PUT /api/v1/system-config/runtime-params` 路由的白名单 map 登记字段名 → 键名。
- 修改动态参数值走设置页（系统配置面板）或 `PUT /system-config/runtime-params`，改完即时生效（读侧每次查询，不缓存或短缓存）。

## 其他项目级约定

- 后端 Node 版代码位于 `ai-app-node/`（TypeScript，AI SDK v7 + Hono + Prisma）；**Java 线已冻结于独立 `java` 分支**（根目录 Java 内容已从本分支清理，回看历史代码 `git checkout java`）。
- 分支策略（2026-09-17 净化后）：`node-migration` = **Node 基分支（唯一活跃开发线）**；`java` = Java 冻结基分支（从 dev 派生）；`dev`/`master` 保留不动；GitHub `main` = 零历史展示快照（orphan 重推制）。
- **Obsidian 文档工作区（重要，所有 agent 必读）**：
  - 项目根的 `obsidian.md` 是**文档指针入口**——本项目全部设计/方案/需求文档的位置索引与看板都在该文件，**进项目后先读它**，不要在项目内新建任何设计文档。
  - 文档真源在 Obsidian vault：`D:\notes\agent研发设计\`（本项目的文档目录）——写方案/查方案/改状态都去 vault 操作（用文件工具直接读写），并同步更新项目根 `obsidian.md` 的看板行。
  - 文档命名/状态四档/演进关系标注沿用全局基线；**写入 vault 的文档必须带 YAML frontmatter 基本属性**：`status`（与文件名一致）/ `author`（辉哥 / 大肥鱼 / Claude Code 等）/ `project`（本项目文档写 `ai_app`）/ `version`（演进文档）/ `date`——参照 vault 中 20 号文档范例。
  - vault 是 git 仓库（远端 gitee 私有库），文档变更后 `git -C D:\notes add -A && git commit && git push` 三连同步。
  - 涉及历史方案背景（如 15 号剧本体系、19_1 多 Agent）时**主动读 vault 对应文档**，不要凭猜测实施。
- **前端图标**：优先使用 `lucide-vue-next` 图标库（按需 import，tree-shaking），**严禁手搓内联 SVG**；已装 v0.577.0。用法：`import { Wrench } from 'lucide-vue-next'` → `<Wrench :size="12" />`。存量手搓 SVG 在触碰相关区域时顺手替换。
