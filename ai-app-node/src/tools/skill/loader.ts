// ============================================================
// Skill 装配模块（批次 3）
// 从 AiApp.skills（JSON，格式 [{code, catalog}]）解析技能绑定，分两种装配模式：
//   - 注入式（catalog 缺省/false）：从 AiSkill 读全文，按绑定顺序拼接注入
//     system prompt，受 skills.max-chars 预算控制（AiSysConfig，默认 20000）
//   - 目录式（catalog=true）：不注入全文，生成 load_skill 工具回调，
//     模型按需从 AiSkill 读取全文；同时在 system prompt 注入技能目录
// assembleSkills() 为统一入口，一次调用同时产出注入文本与 load_skill 工具。
// ============================================================

import type { AiApp, AiSkill } from '@prisma/client'
import { prisma } from '../../db/client.js'
import type { ToolCallback } from '../builtin/index.js'

/** 目录式技能按需加载工具的固定名称 */
export const SKILL_LOAD_TOOL_NAME = 'load_skill'

/** 注入式全文的字符预算上限默认值 */
export const DEFAULT_SKILL_MAX_CHARS = 20000

/** 预算配置在 AiSysConfig 中的 configKey */
const SKILL_MAX_CHARS_KEY = 'skills.max-chars'

/**
 * 技能绑定项（AiApp.skills JSON 数组的元素）
 * - code：技能编码，对应 AiSkill.skillCode
 * - catalog：true = 目录式（按需加载），缺省/false = 注入式（全文注入）
 */
export interface SkillBinding {
  code: string
  catalog?: boolean
}

/** 装配所需的 App 字段子集（传完整 AiApp 记录亦可；skillsEnabled 由 skills 非空推导） */
export type SkillApp = Pick<AiApp, 'skills'>

/** Skill 装配结果 */
export interface SkillAssembleResult {
  /** 需注入 system prompt 的技能文本（注入式全文 + 目录式技能目录），无则空串 */
  prompt: string
  /** 目录式绑定存在时生成的 load_skill 工具回调，否则 null */
  tool: ToolCallback | null
}

// ---------- 绑定解析 ----------

/** 解析 AiApp.skills JSON（[{code, catalog}]）；解析失败或格式非法时返回空数组并告警 */
export function parseSkillBindings(skillsJson?: string | null): SkillBinding[] {
  if (typeof skillsJson !== 'string' || skillsJson.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(skillsJson)
  } catch {
    console.warn('[tools/skill] AiApp.skills JSON 解析失败，忽略技能绑定')
    return []
  }
  if (!Array.isArray(parsed)) {
    console.warn('[tools/skill] AiApp.skills 不是 JSON 数组，忽略技能绑定')
    return []
  }
  const out: SkillBinding[] = []
  for (const item of parsed) {
    // 宽容处理两种元素：纯字符串（视为注入式绑定）或 {code, catalog} 对象
    if (typeof item === 'string') {
      if (item.trim() !== '') out.push({ code: item.trim() })
      continue
    }
    const b = item as { code?: unknown; catalog?: unknown; mode?: unknown }
    if (item && typeof item === 'object' && typeof b.code === 'string' && b.code.trim() !== '') {
      // 兼容两种存储格式：{code, catalog: true} 与 {code, mode: "catalog"}
      const isCatalog = b.catalog === true || b.catalog === 'true' || b.catalog === 1
        || b.mode === 'catalog' || b.mode === 'true' || b.mode === 1
      out.push({ code: b.code.trim(), catalog: isCatalog })
    }
  }
  return out
}

// ---------- 配置与查询 ----------

/** 读取注入式预算 skills.max-chars（AiSysConfig），缺省/非法/DB 异常时回退默认 20000 */
export async function getSkillMaxChars(): Promise<number> {
  try {
    const row = await prisma.aiSysConfig.findUnique({ where: { configKey: SKILL_MAX_CHARS_KEY } })
    const n = row?.configValue !== null && row?.configValue !== undefined ? Number(row.configValue) : NaN
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  } catch (err) {
    console.warn('[tools/skill] 读取 skills.max-chars 配置失败，使用默认值：', err instanceof Error ? err.message : err)
  }
  return DEFAULT_SKILL_MAX_CHARS
}

/** 批量读取启用中的技能（enabled=true 且 delFlag='0'），按 skillCode 建索引 */
async function fetchSkills(codes: string[]): Promise<Map<string, AiSkill>> {
  const map = new Map<string, AiSkill>()
  if (codes.length === 0) return map
  try {
    const rows = await prisma.aiSkill.findMany({
      where: { skillCode: { in: codes }, enabled: true, delFlag: '0' },
    })
    for (const r of rows) map.set(r.skillCode, r)
  } catch (err) {
    console.warn('[tools/skill] 读取 AiSkill 表失败：', err instanceof Error ? err.message : err)
  }
  return map
}

// ---------- 文本拼装 ----------

/** 拼装注入式技能全文：按绑定顺序拼接，整块放不进预算的技能跳过并在末尾标注 */
function buildInjectedText(bindings: SkillBinding[], skills: Map<string, AiSkill>, maxChars: number): string {
  const header = '# 技能（Skills）\n以下技能全文已由系统注入，请遵循其中的指引：\n'
  let used = header.length
  const chunks: string[] = []
  const skipped: string[] = []
  for (const b of bindings) {
    const s = skills.get(b.code)
    if (!s) continue // 未入库/未启用/已删除的绑定直接跳过
    const chunk = `\n## ${s.name}（code: ${s.skillCode}）\n\n${s.content}\n`
    if (used + chunk.length > maxChars) {
      skipped.push(b.code) // 整块跳过：截断一半的技能指引比缺失更危险
      continue
    }
    used += chunk.length
    chunks.push(chunk)
  }
  if (chunks.length === 0) return ''
  let text = header + chunks.join('')
  if (skipped.length > 0) {
    text += `\n> 注意：技能 ${skipped.join('、')} 因超出 skills.max-chars 预算（${maxChars}）未注入全文。\n`
  }
  return text.trimEnd()
}

/** 拼装目录式技能目录（提示模型用 load_skill 按需加载） */
function buildCatalogText(bindings: SkillBinding[], skills: Map<string, AiSkill>): string {
  const lines = bindings
    .map(b => {
      const s = skills.get(b.code)
      if (!s) return null
      return `- \`${b.code}\`：${s.name}${s.description ? ` — ${s.description}` : ''}`
    })
    .filter((v): v is string => v !== null)
  if (lines.length === 0) return ''
  return ['# 技能目录', '以下技能未直接注入全文，需要时调用 `load_skill` 工具按 code 加载：', ...lines].join('\n')
}

/** 构造目录文本（目录式绑定 → 技能列表字符串），供工具描述复用 */
function buildDirectoryLines(bindings: SkillBinding[], skills: Map<string, AiSkill>): string {
  return bindings
    .map(b => {
      const s = skills.get(b.code)
      if (!s) return null
      return `- \`${b.code}\`：${s.name}${s.description ? ` — ${s.description}` : ''}`
    })
    .filter((v): v is string => v !== null)
    .join('\n')
}

// ---------- load_skill 工具 ----------

/**
 * 生成目录式技能的 load_skill 工具回调。
 * - description 内嵌当前可用技能目录，模型据此选择 code
 * - execute 每次实时查库读全文（技能内容变更即时生效）
 * - 允许加载该应用绑定的任何技能（含因预算不足被跳过注入的，便于兜底）
 * @param bindings 当前应用的全部技能绑定
 * @param prefetched 可选：已预取的技能索引（避免与 assembleSkills 重复查询）
 */
export async function createLoadSkillTool(
  bindings: SkillBinding[],
  prefetched?: Map<string, AiSkill>,
): Promise<ToolCallback> {
  const allowed = new Set(bindings.map(b => b.code))
  const catalogBindings = bindings.filter(b => b.catalog)
  const catalogSkills = prefetched ?? (await fetchSkills(catalogBindings.map(b => b.code)))
  const directory = buildDirectoryLines(catalogBindings, catalogSkills)
  return {
    name: SKILL_LOAD_TOOL_NAME,
    displayName: '技能加载',
    description:
      '按需加载技能的完整内容（全文），加载后请严格遵循技能中的指引完成任务。' +
      '⚠️ 参数名是 code（不是 skill / name）：调用格式 {"code":"技能编码"}。' +
      (directory ? `\n当前可加载的技能：\n${directory}` : '\n传入技能 code 加载其全文。'),
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '要加载的技能编码（参数名 code），必须是当前应用已绑定且列出的技能 code',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        // 参数名容错：模型偶发误用 skill 键（工具名 load_skill 的直觉联想）——兼容降级
        const code = args.code ?? (args as any).skill ?? (args as any).name
        if (typeof code !== 'string' || code.trim() === '') {
          return '错误：缺少参数 code（不是 skill），正确格式：{"code":"技能编码"}'
        }
        const normalized = code.trim()
        if (!allowed.has(normalized)) {
          return `错误：技能 "${normalized}" 未绑定到当前应用，可加载的技能：${[...allowed].join('、') || '（无）'}`
        }
        const skill = await prisma.aiSkill.findFirst({
          where: { skillCode: normalized, enabled: true, delFlag: '0' },
        })
        if (!skill) {
          return `错误：技能 "${normalized}" 不存在或未启用`
        }
        return `# ${skill.name}\n\n${skill.content}`
      } catch (err) {
        return `错误：加载技能失败 - ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }
}

// ---------- 对外装配入口 ----------

/** 仅生成注入式技能全文（不含目录式目录），供需要单独控制注入的调用方使用 */
export async function buildInjectedSkillPrompt(app: SkillApp): Promise<string> {
  if (!app.skills || app.skills === '[]') return ''
  const bindings = parseSkillBindings(app.skills).filter(b => !b.catalog)
  if (bindings.length === 0) return ''
  const skills = await fetchSkills(bindings.map(b => b.code))
  const maxChars = await getSkillMaxChars()
  return buildInjectedText(bindings, skills, maxChars)
}

/**
 * Skill 统一装配入口（读取 AiApp.skills 与 skillsEnabled）：
 * 1. 解析绑定并按 catalog 标记分组：注入式（全文注入）/ 目录式（按需加载）
 * 2. 注入式：按绑定顺序拼接全文，受 skills.max-chars 预算控制
 * 3. 目录式：prompt 注入技能目录，并生成 load_skill 工具回调
 * 返回 { prompt, tool }：prompt 为空串表示无技能注入；tool 为 null 表示无目录式绑定。
 */
export async function assembleSkills(app: SkillApp): Promise<SkillAssembleResult> {
  if (!app.skills || app.skills === '[]') return { prompt: '', tool: null }
  const bindings = parseSkillBindings(app.skills)
  if (bindings.length === 0) return { prompt: '', tool: null }

  const injectedBindings = bindings.filter(b => !b.catalog)
  const catalogBindings = bindings.filter(b => b.catalog)

  const skills = await fetchSkills(bindings.map(b => b.code))
  const injectedPrompt =
    injectedBindings.length > 0 ? buildInjectedText(injectedBindings, skills, await getSkillMaxChars()) : ''
  const catalogPrompt = catalogBindings.length > 0 ? buildCatalogText(catalogBindings, skills) : ''
  const tool = catalogBindings.length > 0 ? await createLoadSkillTool(bindings, skills) : null

  const prompt = [injectedPrompt, catalogPrompt].filter(Boolean).join('\n\n')
  return { prompt, tool }
}
