// ============================================================
// 系统指令注册表（15 号：MODE_REGISTRY——剧本体系的唯一真源）
// - UI 层显示名「系统指令」；一个指令 = 一份执行配方（script/inlineSkills/ensureTools）
// - 配方与代码强耦合（引用工具名/控制流程/绑定 sink），故代码级不表化（决策 #13）
// - 附属技能（meta-skill 类）**代码常量、不入表**（辉哥 2026-09-15 拍板）：
//   与 load_skill 同款内部资产——表里不体现，杜绝被用户绑定到应用的泄漏面
// - 依赖面收敛（决策 #15）：仅使用系统内置资产——工具只挂 builtin（MCP 一律不挂）
// - 前置校验（决策 #16）：用户 @ 调用时体检工具依赖（附属技能为代码常量，天然恒可用）
// ============================================================

import { prisma } from '../db/client.js'

export interface ModeRecipe {
  /** 剧本文本（system prompt 注入，代码常量——与流程结构强耦合） */
  script: string
  /** 附属技能全文（代码常量数组，剧本注入时拼接；不入 ai_skill 表） */
  inlineSkills: string[]
  /** 流程刚需工具（ai_builtin_tool 表有记录且停用时拒绝进入） */
  ensureTools: string[]
}

// ---------- 技能工坊（skill-craft）剧本文本 ----------

const SKILL_CRAFT_SCRIPT = `# 技能工坊模式（skill-craft）执行剧本
你处于技能工坊模式：从当前会话沉淀一个可复用技能。严格按以下步骤执行，不得跳步：

1.【主题确认】query 含明确主题 → 直接进入 2；
   主题不明/会话多主题 → 调 ack 工具询问用户要沉淀的主题，等用户答复后进入 2
2.【素材检索】围绕主题调 query_recent_messages 与 query_tool_calls：
   指令序列、工具链与参数、用户的纠正点、失败教训——只取与主题相关部分（全量历史，关键词过滤）
3.【草稿输出】按《技能编写规范》（已附）模板产出技能草稿全文，输出到对话正文；
   草稿末尾调 ack：选项[确认定稿 / 输入修改意见]，用户有反馈 → 回到 2 补充检索 → 再草稿 → 再 ack
4.【终稿确认】用户确认草稿后：拟定 name（中文）、code（kebab-case）、description（一句话），
   调 ack 展示三项 + 询问"是否绑定当前应用（目录式）？下次对话即可用"
5.【落库】用户在步骤 4 的 ack 中做出绑定选择（bind / no_bind / 是 / 否 等任何答复）后，
   【立即】调 create_skill 落库（bindCurrentApp=绑定类答复为 true，否则 false）——
   这一步【没有再次确认环节】：收到绑定选择本身就是落库指令，严禁再发任何 ack 或回到草稿确认；
   落库成功后告知用户技能名与下次使用方式，本轮流程结束

约束：
- 未经步骤 4 用户确认，严禁调用 create_skill
- 步骤 4 的绑定选择答复之后，唯一的合法动作是调 create_skill（禁止再 ack / 再出草稿）
- 草稿只写与主题相关的流程，不得夹带无关内容
- 全程使用中文`

// ---------- 技能编写规范（meta-skill：剧本附属技能，代码常量不入表） ----------
// 2026-09-17 v2.0：逆向提炼 chart-generation / mermaid-generation / knowledge-retrieval
// 三个精品内置技能的共同范式重写（提示词研判 02 号执行项③）——从"教结构"升级为"教什么算好"。

const META_SKILL_CONTENT = `# 技能编写规范（meta-skill v2）

> 本规范是技能工坊的产出标准：剧本注入时自动带上，生成的技能必须遵循。
> 范式提炼自平台三个精品内置技能（chart-generation / mermaid-generation / knowledge-retrieval）——
> **一份好技能的标准不是"结构齐全"，而是"模型读后零歧义、可直接照做、知道边界在哪"**。

## 一、技能的本质定位

技能不是文档，是**给模型的行为契约**——模型加载后按它行动。因此每一段内容都要回答一个问题：
"模型读完这段，行为会发生什么变化？"答不上来的段落删掉。

三大反例（不合格技能的样子）：
- ❌ 流程描述型："首先查询数据，然后处理数据，最后输出结果"——模型本来就懂流程，等于没写
- ❌ 空话约束型："注意质量""确保准确"——不可判定，等于没约束
- ❌ 场景堆砌型：触发条件写了十种情况但互有重叠——模型不知道该不该触发

## 二、内容六要素（按精品技能实证的优先级排序）

### 1. 触发条件——可判定的"信号词 + 场景"
- 写**具体信号**（用户说了什么话/任务到了哪一步），不写抽象意图
  - ✅ "用户明确要求画图/可视化""统计类任务已得出结果且适合可视化"
  - ❌ "需要数据展示时"（模糊——什么算"需要"？）
- **不触发清单必须写**（防过度触发比防漏触发更重要）：
  - ✅ "纯概念解释、流程说明""数据量太小（如仅 1-2 个数值）""用户明确要求不要画图"
- 触发与不触发之间不留灰区：拿不准的场景明确归到一边

### 2. 输出协议——精确到"格式骨架"
- 输出物给**格式骨架**（代码块类型/结构/必填字段），不是口头描述
  - ✅ "输出一个 \`\`\`echarts 代码块，内容为一个合法 JSON 对象；必须是纯 JSON——禁止注释、单引号、尾逗号"
- 骨架里的硬约束逐条列出（"块闭合即完成，块外不要重复输出"）

### 3. 选型/决策表——把判断变成查表
- 有多种做法时给**对照表**，让模型查表而不是临场发挥
  - ✅ "| 类别对比 | 柱状图 | \`bar\` |　| 时间趋势 | 折线图 | \`line\` |"
- 表格三列起：需求场景 → 做法 → 关键参数/标记

### 4. 精细化规则——分档处理边界
- 同一规则按数据规模/场景分档，写清每档的做法
  - ✅ "折线图 label：数据点 ≤12 全显；>12 仅极值；时间序列至少标首尾"
- 分档的临界值给具体数字（12/20/15 个），不写"较多""较少"

### 5. 与相关技能的关系——协作与互斥都写
- 协作："同一回答需要两种图 → 分别输出，互不干扰"
- 互斥："有数据走 chart-generation，无数据走 mermaid-generation——严禁混用"
- 平台已有相近技能时**必须**写这节（否则模型随机选）

### 6. 禁忌——可判定的"禁止条款"
- 每条禁忌都是可判定的行为边界，不是态度要求
  - ✅ "不得编造数据：数据必须来自对话上下文或工具调用结果；不足时明确告知并列出所需数据，禁止虚构"
  - ✅ "不得输出无标签的素图（读者不 hover 也能读到数值）"
- 禁忌条数 3-5 条为宜——太多说明前面几节没写清楚

## 三、结构与模板

\`\`\`
# 技能名（中文，一句话定位）
## 触发条件（满足任一）/ 不触发
## 与相关技能的关系（平台有相近技能时必写）
## 输出协议（格式骨架 + 硬约束）
## 选型/决策表（多做法时）
## 精细化规则（分档 + 临界值）
## 多份输出规范（一次产出多份时）
## 禁忌（3-5 条可判定条款）
## 完整示例（可直接复制的正例，含最小可用样例）
\`\`\`

- 示例**必须完整可执行**：不是片段，是"用户这么问 → 技能产出这个"的完整对照（参照 chart-generation 的销量对比示例——一个 option 全字段）
- 示例 1-2 个：一个典型正例 + 一个易错场景的纠正示例（如饼图必须带 label formatter）

## 四、写作检查清单（草稿自检）

1. **可判定**：每条触发/不触发/禁忌都能回答"是/否"，无模糊词（"尽量""注意""合适"）
2. **零歧义**：拿掉任何一节，模型行为会变差吗？不会 → 删
3. **查表化**：临场判断的场合是否都给了对照表或分档规则？
4. **示例可跑**：正例贴进对话能直接复现预期产出？
5. **含教训**：用户在本次会话中的纠正点写进规则了吗（这是技能最珍贵的部分——踩过的坑变成条款）
6. **工具真实**：引用的工具名必须是平台实际存在的全名；不确定就写"调用当前应用可用的查询类工具"`

// ---------- 会话总结（session-summary）剧本文本 ----------

const SESSION_SUMMARY_SCRIPT = `# 会话总结模式（session-summary）执行剧本
你处于会话总结模式：总结当前会话并导出文件。
⚠️ 核心纪律：**本流程以导出文件为唯一终点——只输出总结正文而不调 export_file = 流程失败**。
无论用户 query 如何表述（"总结工具情况"/"总结进展"/纯 @ 无主题），都视为总结的**素材视角**——
产出物必须是总结文件（内容围绕该视角组织），**严禁退化成一问一答的信息查询**。

严格按以下步骤执行，不得跳步：

1.【素材】当前上下文已含本会话消息；需要更早历史或工具明细时
   调 query_recent_messages / query_tool_calls 补充（不要遗漏关键产出内容）
2.【先导出】先调 export_file（此动作必须在本轮完成，先于正文输出）：
   filename 用 builtin_current_time 取当日日期拼核心主题（如 "2026-09-16-国庆长沙7日游方案总结.md"）
3.【再输出正文】导出成功后，正文输出速览版 + 文件下载链接

⚠️ 总结内容的第一原则——**用户关心什么，总结的主体就是什么**：
先判断会话类型，选对模板：

【方案/规划产出型会话】（如旅游方案/实施方案/报告/清单——会话核心是一份产出物）：
   **总结主体 = 产出物本身的内容详版**（行程安排/方案要点/结论清单——用户离开对话后要看的正是这个，必须完整可脱离对话独立使用），
   辅以少量过程信息：关键决策点（为什么这样定）、注意事项/风险、待办确认项。
   ⚠️ 严禁喧宾夺主：过程中的问题排查/工具故障/格式调整等**只在"过程备注"一节各用一句话点出**，
   不要表格化展开"问题→处理"——那是工作报告的视角，不是用户对方案总结的需求。

【工作/任务型会话】（如 bug 修复/技能沉淀/数据处理）：
   六节工作视角（工作内容/发现的问题/处理方式/完成状态/最终结果/总结）。
   ⚠️ 同样适用第一原则：产出物（生成的技能/文件/结论数据）在"最终结果"详细展开。

【混合型】（如本例：验证工具 + 产出旅游方案）：以**产出型为主体**，工作过程并入"过程备注"。

导出文件与正文同构（正文为速览版，重点部分完整保留）；忠实于会话内容，不编造；全程中文。

约束：
- 判断会话类型的依据：会话的最终产出物是什么（方案？技能？结论？），用户反复打磨的内容就是主体
- 正文速览版 500 字内，但主体内容（如行程）在导出文件中必须完整详细
- export_file 调用失败时：告知用户失败原因并重试（换简单文件名），仍以导出成功为终点`

// ---------- 注册表（新增系统指令在此登记；ai_at_command 表同步预置入口行） ----------

export const MODE_REGISTRY: Record<string, ModeRecipe> = {
  'skill-craft': {
    script: SKILL_CRAFT_SCRIPT,
    inlineSkills: [META_SKILL_CONTENT],
    // ensureTools = 流程依赖声明：
    //   - create_skill / ack_user 不入 ai_builtin_tool 表（附属工具，装配时 extraTools 直通，恒可用）
    //   - query_* 为表管常规工具（14 号 required=1）——管理员表级停用时前置校验 fail-fast
    ensureTools: ['ack_user', 'create_skill', 'query_recent_messages', 'query_tool_calls'],
  },
  'session-summary': {
    script: SESSION_SUMMARY_SCRIPT,
    inlineSkills: [],
    // export_file 为 mode 专用附属工具（装配时工厂直通）；总结无确认环节（低风险产物直出）
    ensureTools: ['export_file', 'query_recent_messages', 'query_tool_calls'],
  },
  // 报告模式（预留，15 号 §6.2）：sink = export_file 落盘，追加 ~1 天
}

// ---------- 前置校验（决策 #16：用户 @ 调用时体检依赖，防无效调用） ----------

export interface ModeCheckResult {
  ok: boolean
  error?: string
  recipe?: ModeRecipe
}

/**
 * 校验系统指令的依赖是否全部可用（依据注册表——唯一真源）：
 * ensureTools 逐个查 ai_builtin_tool（表无记录 = 默认启用；有记录且停用 = 拒绝）。
 * 附属技能为代码常量（inlineSkills），天然恒可用，无需校验。
 * 任一失效返回明确错误文案（用户 @ 时 400 拒绝进入；ack 续跑轮降级中止）。
 */
export async function checkModeDeps(modeCode: string): Promise<ModeCheckResult> {
  const recipe = MODE_REGISTRY[modeCode]
  if (!recipe) return { ok: false, error: `未知系统指令：${modeCode}` }

  for (const toolCode of recipe.ensureTools) {
    // 与 getBuiltinToolSelection 同语义：表无记录 = 默认启用（开箱即用）；有记录且停用 = 拒绝
    const t = await prisma.aiBuiltinTool.findFirst({ where: { toolCode, delFlag: '0' } })
    if (t && !t.enabled) return { ok: false, error: `系统必需工具 [${toolCode}] 已停用，该流程暂不可用` }
  }
  return { ok: true, recipe }
}

// ---------- mode 会话标记生命周期 ----------

/** 进入系统指令：写会话 mode 标记（ack 续跑轮据此保持注入） */
export async function setConversationMode(conversationPk: number, modeCode: string): Promise<void> {
  await prisma.aiConversation.update({ where: { id: conversationPk }, data: { mode: modeCode, updateTime: new Date() } })
}

/** sink 完成后清除 mode 标记（会话回归普通对话） */
export async function clearConversationMode(conversationPk: number): Promise<void> {
  await prisma.aiConversation.update({ where: { id: conversationPk }, data: { mode: null, updateTime: new Date() } })
}

/** 读取会话当前 mode（无会话/无标记返回 null） */
export async function getConversationMode(conversationPk: number | null): Promise<string | null> {
  if (!conversationPk) return null
  const conv = await prisma.aiConversation.findFirst({ where: { id: conversationPk }, select: { mode: true } })
  return conv?.mode ?? null
}
