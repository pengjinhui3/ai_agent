import request from './request'

/** 内置工具治理（/api/v1/builtin-tools，08_2 基础能力治理：代码播种 + 系统级启停） */
export const builtinToolsApi = {
  list: () => request.get('/builtin-tools'),
  setEnabled: (id, value) => request.post(`/builtin-tools/${id}/enabled?value=${value}`)
}
