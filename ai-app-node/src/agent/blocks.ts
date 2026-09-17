/** 内容块类型定义 + 流式聚合器（13 号方案：content_blocks） */

export interface ContentBlock {
  type: 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'media' | 'plan'
  content: string | { name: string; args?: unknown } | { mediaIndex: number; title: string | null } | { steps: { index: number; desc: string; tool?: string }[] }
  index: number
  source?: string        // tool_use 专用：'builtin' | 'mcp:{code}' | 'skill'
  displayName?: string   // tool_use 专用：用户可读显示名（MCP 原始工具名 / 内置表 name / 技能加载）
  status?: string       // tool_use 专用：'running' | 'done' | 'error' | 'cancelled'
  costMs?: number       // tool_use 专用
  toolError?: string    // tool_use 专用
}

export class BlockAggregator {
  private blocks: ContentBlock[] = []

  handleReasoningDelta(text: string): void {
    const last = this.blocks[this.blocks.length - 1]
    if (last?.type === 'thinking' && typeof last.content === 'string') {
      last.content += text
    } else {
      this.blocks.push({ type: 'thinking', content: text, index: this.blocks.length })
    }
  }

  handleTextDelta(text: string): void {
    const last = this.blocks[this.blocks.length - 1]
    if (last?.type === 'text' && typeof last.content === 'string') {
      last.content += text
    } else {
      this.blocks.push({ type: 'text', content: text, index: this.blocks.length })
    }
  }

  handleToolCall(name: string, args: unknown, source: string, displayName?: string): number {
    this.blocks.push({
      type: 'tool_use',
      content: { name, args },
      source, ...(displayName && { displayName }), status: 'running', index: this.blocks.length,
    })
    return this.blocks.length - 1
  }

  handleToolResult(blockIndex: number, result: string, costMs: number, error?: string): void {
    const block = this.blocks[blockIndex]
    if (block?.type === 'tool_use') {
      block.status = error ? 'error' : 'done'
      block.costMs = costMs
      if (error) block.toolError = error
    }
    this.blocks.push({ type: 'tool_result', content: result, index: this.blocks.length })
  }

  handleMedia(mediaIndex: number, title: string | null): void {
    this.blocks.push({
      type: 'media',
      content: { mediaIndex, title },
      index: this.blocks.length,
    })
  }

  /** plan 块（07_2 序 1：reasoning 自规划的步骤计划，```plan 代码块劫持而来） */
  handlePlan(steps: { index: number; desc: string; tool?: string }[]): void {
    this.blocks.push({
      type: 'plan',
      content: { steps },
      index: this.blocks.length,
    })
  }

  finalize(): ContentBlock[] {
    this.blocks.forEach(b => { if (b.status === 'running') b.status = 'done' })
    return this.blocks
  }

  get answerPure(): string {
    return this.blocks.filter(b => b.type === 'text').map(b => b.content).join('\n')
  }
}

export function generateAnswerPure(blocks: ContentBlock[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.content).join('\n')
}
