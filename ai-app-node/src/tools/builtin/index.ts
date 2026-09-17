// ============================================================
// 内置工具模块（批次 3）
// 定义统一工具回调格式 ToolCallback，并提供两个内置工具：
//   - builtin_current_time：获取当前日期时间（含时区/星期）
//   - builtin_datetime_calc：日期时间计算（加减天数/小时等）
// 工具的启用状态从 DB 的 AiBuiltinTool 表读取（enabled 过滤）。
// ============================================================

import { prisma } from '../../db/client.js'
import { knowledgeSearch } from './knowledge.js'

/** 工具参数的 JSON Schema 类型（宽松定义，兼容任意 JSON Schema 结构） */
export type ToolParametersSchema = Record<string, unknown>

/**
 * 统一工具回调格式
 * - name:        工具全名（内置工具为 builtin_ 前缀）
 * - description: 工具描述（会作为工具说明暴露给模型）
 * - parameters:  参数 JSON Schema（type/properties/required 等）
 * - execute:     执行工具，入参为模型给出的参数对象，返回字符串结果
 *                （约定：错误也返回字符串，便于模型自行纠正）
 */
export interface ToolCallback {
  name: string
  /** 用户可读显示名（前端展示优先用；缺省时前端退回编码短名） */
  displayName?: string
  description: string
  parameters: ToolParametersSchema
  execute(args: Record<string, unknown>): Promise<string>
}

// ---------- 日期时间工具函数 ----------

/** 校验 IANA 时区名是否可用，不可用返回 null */
function safeTimezone(tz?: unknown): string | null {
  if (typeof tz !== 'string' || tz.trim() === '') return null
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: tz })
    return tz.trim()
  } catch {
    return null
  }
}

/** 把 Date 格式化为人类可读字符串（含星期/时区）；tz 传入时按该时区展示 */
function formatDate(d: Date, tz?: string): string {
  const zone = safeTimezone(tz)
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
    timeZoneName: 'long',
    ...(zone ? { timeZone: zone } : {}),
  }
  const parts = new Intl.DateTimeFormat('zh-CN', opts).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const ymd = `${get('year')}-${get('month')}-${get('day')}`
  const hms = `${get('hour')}:${get('minute')}:${get('second')}`
  const week = get('weekday')
  const zoneName = get('timeZoneName')
  // 未指定时区时，额外给出服务器本地 UTC 偏移（如 UTC+08:00）
  const gmt = zone
    ? ''
    : (() => {
        const off = -d.getTimezoneOffset()
        const sign = off >= 0 ? '+' : '-'
        const abs = Math.abs(off)
        return `，UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
      })()
  return `${ymd} ${hms} ${week}（${zoneName}${gmt}）`
}

// ---------- 内置工具 1：builtin_current_time ----------

const builtinCurrentTime: ToolCallback = {
  name: 'builtin_current_time',
  displayName: '当前时间',
  description:
    '获取当前日期时间，返回本地可读格式（含时区、星期）、ISO 8601 与 Unix 时间戳。' +
    '可选传入 IANA 时区名（如 Asia/Shanghai、America/New_York）以查看对应时区时间。',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: '可选，IANA 时区名，如 Asia/Shanghai；不传则使用服务器本地时区',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(args) {
    try {
      const now = new Date()
      const tzRaw = args.timezone
      if (tzRaw !== undefined && !safeTimezone(tzRaw)) {
        return `错误：无效的时区名 "${String(tzRaw)}"，请使用 IANA 时区名，例如 Asia/Shanghai`
      }
      const local = formatDate(now, tzRaw === undefined ? undefined : String(tzRaw))
      return [
        `当前时间：${local}`,
        `ISO 8601：${now.toISOString()}`,
        `Unix 时间戳（秒）：${Math.floor(now.getTime() / 1000)}`,
        `Unix 时间戳（毫秒）：${now.getTime()}`,
      ].join('\n')
    } catch (err) {
      return `错误：获取当前时间失败 - ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

// ---------- 内置工具 2：builtin_datetime_calc ----------

/** 解析基准时间：'now' / 缺省 = 当前时刻，其余交给 Date 解析（ISO 等标准格式） */
function parseBaseTime(base?: unknown): Date {
  if (base === undefined || base === null || String(base).trim() === '' || String(base).trim() === 'now') {
    return new Date()
  }
  const d = new Date(String(base))
  if (Number.isNaN(d.getTime())) {
    throw new Error(`无法解析基准时间 "${String(base)}"，请使用 ISO 8601 格式（如 2025-06-15T14:30:00）或 "now"`)
  }
  return d
}

/** 加自然月（溢出时回退到目标月月末，如 1-31 + 1 个月 = 2-28/29） */
function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime())
  const day = r.getDate()
  r.setDate(1) // 先固定到 1 号，避免 31 号跳月
  r.setMonth(r.getMonth() + n)
  const lastDayOfTarget = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate()
  r.setDate(Math.min(day, lastDayOfTarget))
  return r
}

function toNumber(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0
  const n = Number(v)
  if (Number.isNaN(n)) throw new Error(`数值参数无效：${String(v)}`)
  return n
}

const builtinDatetimeCalc: ToolCallback = {
  name: 'builtin_datetime_calc',
  displayName: '日期时间计算',
  description:
    '日期时间计算：以 base 为基准，加减年/月/周/天/小时/分钟/秒后得到目标时间（含星期、ISO 8601、Unix 时间戳）。' +
    '支持同时传多个偏移量（如同时加 1 天又减 2 小时）；不传任何偏移量则仅格式化基准时间。',
  parameters: {
    type: 'object',
    properties: {
      base: {
        type: 'string',
        description: '基准时间，"now" 表示当前时刻，或 ISO 8601 字符串（如 2025-06-15T14:30:00、2025-06-15）；缺省为 now',
      },
      years: { type: 'number', description: '加减年数（可为负）' },
      months: { type: 'number', description: '加减月数（可为负，溢出自动回退到月末）' },
      weeks: { type: 'number', description: '加减周数（可为负）' },
      days: { type: 'number', description: '加减天数（可为负）' },
      hours: { type: 'number', description: '加减小时数（可为负）' },
      minutes: { type: 'number', description: '加减分钟数（可为负）' },
      seconds: { type: 'number', description: '加减秒数（可为负）' },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(args) {
    try {
      const base = parseBaseTime(args.base)
      const years = toNumber(args.years)
      const months = toNumber(args.months)
      const weeks = toNumber(args.weeks)
      const days = toNumber(args.days)
      const hours = toNumber(args.hours)
      const minutes = toNumber(args.minutes)
      const seconds = toNumber(args.seconds)

      const offsets = [
        ['年', years], ['月', months], ['周', weeks], ['天', days],
        ['小时', hours], ['分钟', minutes], ['秒', seconds],
      ]
        .filter(([, v]) => (v as number) !== 0)
        .map(([unit, v]) => `${(v as number) > 0 ? '+' : ''}${v} ${unit}`)
        .join('，')

      if (offsets === '') {
        return `计算结果：${formatDate(base)}\nISO 8601：${base.toISOString()}\nUnix 时间戳（秒）：${Math.floor(base.getTime() / 1000)}`
      }

      let result = new Date(base.getTime())
      if (years !== 0) result = addMonths(result, years * 12)
      if (months !== 0) result = addMonths(result, months)
      if (weeks !== 0) result = new Date(result.getTime() + weeks * 7 * 24 * 3600 * 1000)
      if (days !== 0) result = new Date(result.getTime() + days * 24 * 3600 * 1000)
      if (hours !== 0) result = new Date(result.getTime() + hours * 3600 * 1000)
      if (minutes !== 0) result = new Date(result.getTime() + minutes * 60 * 1000)
      if (seconds !== 0) result = new Date(result.getTime() + seconds * 1000)

      return [
        `基准时间：${formatDate(base)}`,
        `偏移量：${offsets}`,
        `计算结果：${formatDate(result)}`,
        `ISO 8601：${result.toISOString()}`,
        `Unix 时间戳（秒）：${Math.floor(result.getTime() / 1000)}`,
      ].join('\n')
    } catch (err) {
      return `错误：日期时间计算失败 - ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

// ---------- 注册表与 DB 过滤 ----------

/** 全部内置工具静态定义（新增内置工具时在此登记） */
export const BUILTIN_TOOLS: readonly ToolCallback[] = [builtinCurrentTime, builtinDatetimeCalc, knowledgeSearch]

/** 内置工具 DB 选择结果 */
export interface BuiltinToolSelection {
  /** AiBuiltinTool 表中 enabled 的工具（已按 toolCode 匹配到静态定义） */
  tools: ToolCallback[]
  /** 其中 required=true 的 toolCode（必选工具，可由调用方决定是否豁免白名单） */
  requiredCodes: string[]
}

/**
 * 从 DB 读 AiBuiltinTool 表的 enabled 状态，过滤出当前启用的内置工具。
 * - delFlag='0' 且 enabled=true 的记录才算启用
 * - 表中无记录的工具默认视为启用（便于未初始化数据时开箱即用）
 * - DB 不可用时降级返回全部内置工具（fail-open，避免 DB 抖动导致工具全失效）
 */
export async function getBuiltinToolSelection(): Promise<BuiltinToolSelection> {
  let rows: { toolCode: string; enabled: boolean; required: boolean; name: string; description: string | null }[]
  try {
    rows = await prisma.aiBuiltinTool.findMany({
      where: { delFlag: '0' },
      select: { toolCode: true, enabled: true, required: true, name: true, description: true },
    })
  } catch (err) {
    console.warn('[tools/builtin] 读取 AiBuiltinTool 表失败，降级返回全部内置工具：', err instanceof Error ? err.message : err)
    return { tools: [...BUILTIN_TOOLS], requiredCodes: [] }
  }

  const byCode = new Map(rows.map(r => [r.toolCode, r]))
  const tools: ToolCallback[] = []
  const requiredCodes: string[] = []
  for (const def of BUILTIN_TOOLS) {
    const row = byCode.get(def.name)
    if (row && !row.enabled) continue // 表中有记录且未启用 → 过滤掉
    // 表为唯一真源（与技能治理一致）：name/description 全从表取，代码静态定义仅兜底
    // （代码只负责实现：execute + parameters）
    tools.push({
      ...def,
      displayName: row?.name || def.displayName,
      description: row?.description || def.description,
    })
    if (row?.required) requiredCodes.push(def.name)
  }

  // 插拔式（18 号方案决策 #4-③）：KB 未启用（kb_config.enabled=false：未配置或未通过测试启用）
  // → 知识库工具整体下架（模型不可见、零 token 占用；「测试并启用」即恢复——状态=配置字段，零探测）
  if (tools.some(t => t.name === 'builtin_knowledge_search')) {
    const { readKbConfig } = await import('../../kb/availability.js')
    const cfg = await readKbConfig()
    if (!cfg.enabled) {
      const idx = tools.findIndex(t => t.name === 'builtin_knowledge_search')
      if (idx >= 0) tools.splice(idx, 1)
      const ridx = requiredCodes.indexOf('builtin_knowledge_search')
      if (ridx >= 0) requiredCodes.splice(ridx, 1)
    }
  }

  return { tools, requiredCodes }
}

/** 便捷方法：等价于 getBuiltinToolSelection().tools */
export async function getBuiltinTools(): Promise<ToolCallback[]> {
  return (await getBuiltinToolSelection()).tools
}
