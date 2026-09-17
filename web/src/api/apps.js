import request from './request'

/** 应用管理 + 会话/消息查询（/api/v1/apps、/api/v1/conversations） */
export const appsApi = {
  /** 应用列表（含 id/appCode/name/provider/protocol/model/modelId/toolsEnabled/enabled） */
  list: () => request.get('/apps'),
  /** 应用详情（完整字段：systemPrompt/mcpTools/skills——编辑弹窗回填用） */
  detail: appCode => request.get(`/apps/${encodeURIComponent(appCode)}`),
  /** 创建应用（校验：appCode 唯一 / modelId 存在且启用 / mcpTools JSON 数组） */
  create: data => request.post('/apps', data),
  /** 更新应用（appCode 不可改；换绑模型即时生效） */
  update: (id, data) => request.put(`/apps/${id}`, data),
  /** 删除应用（软删） */
  remove: id => request.delete(`/apps/${id}`),
  /** 启用/停用（停用后对话入口 404，即时生效） */
  setEnabled: (id, value) => request.post(`/apps/${id}/enabled`, null, { params: { value } }),
  /** 某应用的会话列表 */
  conversations: appCode => request.get(`/apps/${encodeURIComponent(appCode)}/conversations`),
  /** 某会话的消息历史（含 answer/answerPure/toolCallsJson 轨迹） */
  messages: conversationId => request.get(`/conversations/${encodeURIComponent(conversationId)}/messages`),
  /** 重命名会话（覆盖自动命名的首问截断标题；空/超长后端校验 400） */
  renameConversation: (conversationId, title) =>
    request.put(`/conversations/${encodeURIComponent(conversationId)}/title`, { title }),
  /** 删除会话（该会话全部消息物理删除，不可恢复） */
  removeConversation: conversationId =>
    request.delete(`/conversations/${encodeURIComponent(conversationId)}`)
}
