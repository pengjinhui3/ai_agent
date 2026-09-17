// ============================================================
// create_skill 内置工具（15 号：技能工坊的 sink——产物落地）
// - 工厂模式：assembleContext 装配时闭包注入会话上下文（convPk/appCode）
//   （ToolCallback.execute 仅收 args，上下文靠闭包携带——load_skill 同款路径）
// - 校验（code 格式/唯一性/结构节/防递归/保留码）→ 事务落库 → 可选绑定 → 清 mode
// - 仅在 skill-craft 剧本流程内由模型在用户确认后调用（剧本约束步骤 5）
// ============================================================

import type { ToolCallback } from '../index.js'
import { prisma } from '../../db/client.js'
import { clearConversationMode } from '../../agent/modes.js'

/** 保留编码（不可被生成技能占用） */
const RESERVED_CODES = new Set(['meta-skill'])

export interface SkillToolCtx {
  conversationPk: number | null
  appCode: string
}

/** 构造 create_skill 工具实例（装配时注入会话上下文） */
export function buildCreateSkillTool(ctx: SkillToolCtx): ToolCallback {
  return {
    name: 'create_skill',
    displayName: '技能入库',
    description:
      '将用户确认终稿的技能落库（技能工坊流程的最终步骤，必须在用户明确确认后调用）。' +
      '参数：name（中文名）/ code（kebab-case 编码）/ description（一句话）/ content（技能全文，须含「## 触发条件」节）/ bindCurrentApp（是否目录式绑定当前应用）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能中文名（如：数据库统计可视化）' },
        code: { type: 'string', description: '技能编码，kebab-case 英文（如：db-stats-chart）' },
        description: { type: 'string', description: '一句话说明（技能目录展示，≤500 字）' },
        content: { type: 'string', description: '技能全文 markdown（按技能编写规范的结构模板）' },
        bindCurrentApp: { type: 'boolean', description: '是否将新技能以目录式绑定到当前应用' },
      },
      required: ['name', 'code', 'description', 'content', 'bindCurrentApp'],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const name = String(args.name || '').trim()
        const code = String(args.code || '').trim()
        const description = String(args.description || '').trim()
        const content = String(args.content || '').trim()
        const bindCurrentApp = args.bindCurrentApp === true

        // ---------- 校验 ----------
        if (!name) return '错误：name 不能为空'
        if (!/^[a-z0-9][a-z0-9-]*$/.test(code)) return `错误：code 必须为 kebab-case（小写字母数字连字符），收到 "${code}"`
        if (description.length > 500) return `错误：description 超长（${description.length} > 500）`
        if (!content.includes('## 触发条件')) return '错误：content 必须包含「## 触发条件」结构节（技能编写规范模板）'
        if (/create_skill|技能工坊/.test(content)) return '错误：content 不得包含技能生成相关指令（防递归引用）'
        if (RESERVED_CODES.has(code)) return `错误：code [${code}] 为系统保留编码`

        const dup = await prisma.aiSkill.findFirst({ where: { skillCode: code, delFlag: '0' } })
        if (dup) return `错误：技能编码 [${code}] 已存在（技能不可覆盖，请换一个 code）`

        // ---------- 溯源信息（源会话） ----------
        const sourceConvId = ctx.conversationPk
          ? (await prisma.aiConversation.findFirst({ where: { id: ctx.conversationPk }, select: { conversationId: true } }))?.conversationId ?? null
          : null

        // ---------- 落库（含可选绑定，事务） ----------
        const skill = await prisma.$transaction(async (tx) => {
          const row = await tx.aiSkill.create({
            data: {
              skillCode: code, name, description, content,
              enabled: true, skillType: 'user', delFlag: '0',
              reserve1: sourceConvId,   // 溯源：由会话 #N 沉淀（15 号决策 #9）
              createTime: new Date(), updateTime: new Date(),
            },
          })
          if (bindCurrentApp && ctx.appCode) {
            const app = await tx.aiApp.findFirst({ where: { appCode: ctx.appCode, delFlag: '0' } })
            if (app) {
              let binds: Array<{ code?: string; mode?: string }> = []
              try { binds = app.skills ? JSON.parse(app.skills) : [] } catch { binds = [] }
              if (!Array.isArray(binds)) binds = []
              if (!binds.some(b => b?.code === code)) {
                binds.push({ code, mode: 'catalog' })
                await tx.aiApp.update({ where: { id: app.id }, data: { skills: JSON.stringify(binds), updateTime: new Date() } })
              }
            }
          }
          return row
        })

        // ---------- sink 完成：清会话 mode（回归普通对话） ----------
        if (ctx.conversationPk) await clearConversationMode(ctx.conversationPk)

        return `技能落库成功：${skill.name}（${skill.skillCode}）` +
          (bindCurrentApp && ctx.appCode ? `，已目录式绑定应用 [${ctx.appCode}]` : '') +
          `。下次对话中提及相关任务即可被目录式加载（load_skill）。`
      } catch (e) {
        return `错误：技能落库失败 - ${e instanceof Error ? e.message : String(e)}（未落库，可修正后重试）`
      }
    },
  }
}
