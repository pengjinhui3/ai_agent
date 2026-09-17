import request from './request'

/** 字典配置（/api/v1/dicts，类型+值两级 CRUD） */
export const dictApi = {
  listTypes: () => request.get('/dicts/types'),
  createType: data => request.post('/dicts/types', data),
  updateType: (id, data) => request.put(`/dicts/types/${id}`, data),
  removeType: id => request.delete(`/dicts/types/${id}`),
  listData: (dictType) => request.get('/dicts/data', { params: dictType ? { dictType } : {} }),
  createData: data => request.post('/dicts/data', data),
  updateData: (id, data) => request.put(`/dicts/data/${id}`, data),
  removeData: id => request.delete(`/dicts/data/${id}`)
}

/** 系统设置（/api/v1/system-config） */
export const systemConfigApi = {
  get: () => request.get('/system-config'),
  saveBaseModel: modelId => request.put('/system-config/base-model', { modelId }),
  /** 批量保存运行参数（动态化第一批）：键缺省不覆盖 */
  saveRuntimeParams: params => request.put('/system-config/runtime-params', params),
  /** 动态参数 CRUD（普通 kv，无联动）：新增 / 更新 / 删除（内置保护） */
  createParam: data => request.post('/system-config', data),
  updateParam: (id, data) => request.put(`/system-config/${id}`, data),
  removeParam: id => request.delete(`/system-config/${id}`)
}
