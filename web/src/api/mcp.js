import request from './request'

/** MCP 服务管理（/api/v1/mcp-servers，sse/streamable 双传输 + 自定义请求头） */
export const mcpApi = {
  list: () => request.get('/mcp-servers'),
  create: data => request.post('/mcp-servers', data),
  update: (id, data) => request.put(`/mcp-servers/${id}`, data),
  remove: id => request.delete(`/mcp-servers/${id}`),
  /** 连接测试（无状态：initialize + 拉取工具列表，仅展示不入库） */
  test: data => request.post('/mcp-servers/test', data),
  /** 启停（启用前应先 test 确认连通） */
  setEnabled: (id, value) => request.post(`/mcp-servers/${id}/enabled?value=${value}`)
}
