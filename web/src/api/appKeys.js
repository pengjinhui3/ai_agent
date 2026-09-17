import request from './request'

/** 应用密钥 API（16 方案：应用嵌出 app-key 管理；完整 key 仅创建时返回一次） */
export const appKeyApi = {
  list: async () => {
    const r = await request.get('/app-keys')
    return r.keys || []
  },
  create: async (payload) => {
    return request.post('/app-keys', payload)
  },
  update: async (id, payload) => {
    return request.put(`/app-keys/${id}`, payload)
  },
  remove: async (id) => {
    return request.delete(`/app-keys/${id}`)
  },
}
