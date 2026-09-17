<script setup>
/**
 * 根组件：路由壳 + Naive UI 全局服务 Provider。
 * /        → ChatView（对话页）
 * /settings → SettingsView（设置页：厂商/模型/应用/MCP/Skill）
 * n-dialog-provider / n-message-provider：useDialog / useMessage 服务式
 * 调用的祖先前提（会话删除确认、操作结果反馈；设置页后续可直接复用）。
 */
import { NDialogProvider, NMessageProvider } from 'naive-ui'
</script>

<template>
  <n-dialog-provider>
    <n-message-provider>
      <router-view />
    </n-message-provider>
  </n-dialog-provider>
</template>

<style>
/* 全局基础样式 */
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Segoe UI', 'Microsoft YaHei', -apple-system, sans-serif;
  color: #303133;
  background: #fff;
}
</style>
