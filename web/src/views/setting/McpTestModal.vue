<script setup>
import { mcpApi } from '../../api/mcp'
import { storeToRefs } from 'pinia'
import { useSettingStore } from '../../stores/setting'

/**
 * MCP 连接测试弹窗（工具列表仅预览，不入库）：
 * 测试成功 → 展示服务信息 + 工具清单 → 用户「确认启用」才真正置 enabled=true。
 */
const store = useSettingStore()
const { mcpTest, saving } = storeToRefs(store)

async function confirmEnableMcp() {
  const id = mcpTest.value.server.id
  await store.withSaving(async () => {
    await mcpApi.setEnabled(id, true)
    mcpTest.value = null
  })
}
</script>

<template>
  <transition name="modal">
    <div v-if="mcpTest" class="st-modal-mask" @click.self="mcpTest = null">
      <div class="st-modal">
        <div class="st-modal-head">
          <div>
            <div class="st-modal-title">连接测试 · {{ mcpTest.server.name || mcpTest.server.serverCode }}</div>
            <div class="st-modal-sub mono">{{ mcpTest.server.type || 'sse' }} · {{ (mcpTest.server.type || 'sse') === 'stdio' ? mcpTest.server.command : mcpTest.server.url }}</div>
          </div>
          <button class="st-modal-close" @click="mcpTest = null">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="st-modal-body">
          <div v-if="mcpTest.loading" class="st-test-status">⏳ 正在连接并拉取工具列表…</div>
          <div v-else-if="mcpTest.error" class="st-test-status error">❌ {{ mcpTest.error }}</div>
          <template v-else-if="mcpTest.result">
            <template v-if="mcpTest.result.success">
              <div class="st-test-status ok">
                ✅ 连接成功 · {{ mcpTest.result.serverName }} v{{ mcpTest.result.serverVersion }} · 协议 {{ mcpTest.result.protocolVersion }}
              </div>
              <div class="st-test-tools-label">发现 {{ mcpTest.result.tools.length }} 个工具（仅预览，不入库）：</div>
              <div class="st-test-tools">
                <div v-for="t in mcpTest.result.tools" :key="t.name" class="st-test-tool">
                  <span class="mono st-test-tool-name">{{ t.name }}</span>
                  <span class="st-test-tool-desc">{{ (t.description || '').replace(/\s+/g, ' ').slice(0, 140) }}</span>
                </div>
              </div>
            </template>
            <div v-else class="st-test-status error">❌ {{ mcpTest.result.error }}</div>
          </template>
        </div>
        <div class="st-modal-foot">
          <button v-if="mcpTest.result && mcpTest.result.success" class="st-btn st-btn-primary" :disabled="saving" @click="confirmEnableMcp">{{ saving ? '启用中…' : '确认启用' }}</button>
          <button class="st-btn st-btn-ghost" @click="mcpTest = null">关闭</button>
        </div>
      </div>
    </div>
  </transition>
</template>
