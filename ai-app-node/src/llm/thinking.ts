/**
 * 模块职责：思考力度（thinking_effort）字典服务。
 *
 * 从 ai_dict_data 表读取 thinking_effort 字典：
 * - effortBudget(label)：把档位 label 换算成 budget_tokens 数值
 *   （dict_value 需配置为十进制数字字符串，如 "16384"；无配置或非法值返回 null）
 * - defaultEffort()：读取 is_default='Y' 的默认档位 label（无默认时兜底 'medium'）
 */
import { prisma } from '../db/client'

/** 思考力度字典类型 */
const DICT_TYPE = 'thinking_effort'

/**
 * 档位 label → budget_tokens 换算。
 * 查字典（dict_type=thinking_effort, dict_label=label）取 dict_value 解析为数字；
 * 未配置 / 软删 / 非数字 / 非正数 → 返回 null（调用方应跳过 thinking 参数）。
 */
export async function effortBudget(label: string): Promise<number | null> {
  const row = await prisma.aiDictData.findFirst({
    where: { dictType: DICT_TYPE, dictLabel: label, delFlag: '0' },
  })
  if (!row?.dictValue) return null
  const n = Number(row.dictValue)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * 读取默认思考档位（is_default='Y'，按 sort 升序取第一个）。
 * 字典未配置默认档位时兜底返回 'medium'，避免上游对话主流程中断。
 */
export async function defaultEffort(): Promise<string> {
  const row = await prisma.aiDictData.findFirst({
    where: { dictType: DICT_TYPE, isDefault: 'Y', delFlag: '0' },
    orderBy: { sort: 'asc' },
  })
  return row?.dictLabel ?? 'medium'
}
