import request from './request'

/** 技能管理（/api/v1/skills，纯提示词文档，绑定注入模式） */
export const skillsApi = {
  list: () => request.get('/skills'),
  create: data => request.post('/skills', data),
  update: (id, data) => request.put(`/skills/${id}`, data),
  remove: id => request.delete(`/skills/${id}`),
  setEnabled: (id, value) => request.post(`/skills/${id}/enabled?value=${value}`)
}
