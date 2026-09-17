import request from './request'

/**
 * 知识库 API（18 号方案 MVP）：文档上传/列表/删除。
 */
export const kbApi = {
  /** 文档列表（含状态/块数） */
  list: () => request.get('/kb/documents').then(r => r.data?.documents ?? r.documents ?? []),

  /** 上传文档（multipart；后端异步管道处理，立即返回） */
  upload: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return request.post('/kb/documents', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
  },

  /** 可用状态（读配置字段，零探测——面板禁用态数据源） */
  status: () => request.get('/kb/status').then(r => r.data ?? r),

  /** 测试并保存（body=页面表单数据——参数无论对错全量落库，enabled/lastTest 跟随探测结果；URL 清空=下架） */
  test: (data) => request.post('/kb/test', data).then(r => r.data ?? r),

  /** 文档分块明细（块序号 + 内容） */
  chunks: (id) => request.get(`/kb/documents/${id}/chunks`).then(r => r.chunks ?? []),

  /** 删除文档（级联块） */
  remove: (id) => request.delete(`/kb/documents/${id}`),
}
