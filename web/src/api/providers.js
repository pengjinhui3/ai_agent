import request from './request'

/** 厂商管理（/api/v1/providers，api-key 出参脱敏；入参空/掩码时后端保持原值） */
export const providersApi = {
  list: () => request.get('/providers'),
  create: data => request.post('/providers', data),
  update: (id, data) => request.put(`/providers/${id}`, data),
  remove: id => request.delete(`/providers/${id}`),
  /** 启停厂商（端点/密钥变更走 update，均会驱逐模型工厂缓存即时生效） */
  setEnabled: (id, value) => request.post(`/providers/${id}/enabled`, null, { params: { value } })
}
