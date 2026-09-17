// 一次性脚本：18 号方案配置键 + 工具表登记（幂等，可重复执行）
import { prisma } from '../src/db/client.js'

async function main() {
  // ① kb_* 配置键（is_builtin=1）
  const keys: Array<[string, string, string]> = [
    ['kb_embedding_url', '知识库 embedding 完整地址', 'http://10.68.124.12:11434/v1/embeddings'],
    ['kb_embedding_model', '知识库 embedding 模型名', 'bge-m3:latest'],
    ['kb_embedding_api_key', '知识库 embedding API Key（三方平台鉴权，本地留空）', ''],
    ['kb_embed_timeout_seconds', '知识库 embedding 超时秒数', '15'],
    ['kb_top_k', '知识库检索返回条数', '6'],
    ['kb_min_similarity', '知识库相似度阈值', '0.35'],
  ]
  for (const [key, name, value] of keys) {
    const exist = await prisma.aiSysConfig.findFirst({ where: { configKey: key, delFlag: '0' } })
    if (exist) {
      await prisma.aiSysConfig.update({ where: { configId: exist.configId }, data: { configValue: value } })
      console.log(`✓ 更新 ${key} = ${value}`)
    } else {
      await prisma.aiSysConfig.create({ data: { configKey: key, configName: name, configValue: value, isBuiltin: true, delFlag: '0', createTime: new Date(), updateTime: new Date() } })
      console.log(`✓ 新增 ${key} = ${value}`)
    }
  }

  // ② builtin 工具表登记（knowledge_search；非 required——未配 url 时由代码侧剔除）
  const toolCode = 'builtin_knowledge_search'
  const existTool = await prisma.aiBuiltinTool.findFirst({ where: { toolCode, delFlag: '0' } })
  const desc = '检索本地知识库（用户上传的私有文档/资料），返回最相关的原文片段。问题涉及私有知识、内部文档、项目资料时先检索再回答；常识/闲聊/会话内已确认事实不需要。'
  if (existTool) {
    await prisma.aiBuiltinTool.update({ where: { id: existTool.id }, data: { name: '知识库检索', description: desc, enabled: true } })
    console.log('✓ 更新工具 builtin_knowledge_search')
  } else {
    await prisma.aiBuiltinTool.create({
      data: {
        toolCode, name: '知识库检索', description: desc,
        enabled: true, required: false, delFlag: '0',
        createTime: new Date(), updateTime: new Date(),
      },
    })
    console.log('✓ 新增工具 builtin_knowledge_search')
  }

  // ③ knowledge-retrieval 技能（指导模型何时检索知识库）
  const skillCode = 'knowledge-retrieval'
  const skillContent = `## 触发条件
用户的问题涉及知识库中可能存在的内容时，先调用 builtin_knowledge_search 工具检索再回答：
- 提到内部文档、项目资料、已上传的规范/手册/说明类内容
- 询问特定文档里写了什么（如"部署文档里怎么配置XX"）
- 问题中的专有名词/流程/参数疑似来自私有资料而非公知常识

## 不触发
- 公开常识问题（通用编程、数学、日常知识）
- 闲聊与寒暄
- 本会话中已经确认过的事实（用会话记忆回查工具，不是知识库）
- 用户明确说"不用查"时

## 使用规范
1. query 参数用完整自然语言描述要查的内容（不是关键词堆砌），与用户问题的语义对齐
2. 检索返回片段后：综合片段内容回答，并注明信息来自知识库文档（可提文档名）
3. 返回"未检索到相关内容"：直接说明知识库中没有，基于已有知识回答，不臆造
4. 返回"知识库检索暂不可用"：这是服务降级提示——正常继续对话，不要重试超过一次，明确告知用户知识库暂时不可用
5. 一次提问最多检索 2 次（换角度的 query）；多于 2 次仍无结果就基于已有知识回答

## 与其他能力的关系
- 会话记忆（query_* 工具）：查"我们之前聊过什么"——对话内知识
- 本技能（builtin_knowledge_search）：查"文档里写了什么"——外部知识
- 两者边界清晰，不要用知识库工具查会话内容，反之亦然`
  const existSkill = await prisma.aiSkill.findFirst({ where: { skillCode, delFlag: '0' } })
  if (existSkill) {
    await prisma.aiSkill.update({ where: { id: existSkill.id }, data: { content: skillContent, enabled: true, skillType: 'builtin' } })
    console.log('✓ 更新技能 knowledge-retrieval')
  } else {
    await prisma.aiSkill.create({
      data: {
        skillCode, name: '知识库检索时机', description: '指导模型何时调用知识库检索工具，以及与记忆回查的边界',
        content: skillContent, enabled: true, skillType: 'builtin', delFlag: '0',
        createTime: new Date(), updateTime: new Date(),
      },
    })
    console.log('✓ 新增技能 knowledge-retrieval')
  }

  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
