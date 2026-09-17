import request from './request'

/** 模型管理（/api/v1/models，模型名厂商内唯一——同一模型可挂多厂商端点） */
export const modelsApi = {
  /** 全部模型；传 providerCode 时按厂商过滤（级联下拉用） */
  list: (providerCode) => request.get('/models', providerCode ? { params: { providerCode } } : undefined),
  create: data => request.post('/models', data),
  update: (id, data) => request.put(`/models/${id}`, data),
  remove: id => request.delete(`/models/${id}`),
  /** 连通性测试（"你好"最简提示词）：通过 → 直接启用；失败 → 400 可读错误 */
  test: id => request.post(`/models/${id}/test`)
}
