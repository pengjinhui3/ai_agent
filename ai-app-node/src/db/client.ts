import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

// ============================================================
// 软删除统一抽象（19_0 序 1，源自 20 号 §3.3 研判共识）
// - 存量散落的 { delFlag: '0' } 走侦察兵规则渐进替换，不单独排任务
// - 新代码一律使用 ACTIVE / whereActive，禁止裸写 delFlag
// ============================================================

/** 活跃记录过滤条件（语义化常量，Prisma where 展开） */
export const ACTIVE = { delFlag: '0' as const }

/** 将 where 条件与活跃过滤合并（强类型版：保留 T 的字段类型） */
export function whereActive<T extends Record<string, unknown>>(
  where: T,
): T & { delFlag: '0' } {
  return { ...where, delFlag: '0' }
}
