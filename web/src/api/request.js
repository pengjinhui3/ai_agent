import axios from 'axios'

/**
 * axios 实例：统一 baseURL / 超时 / 错误拦截。
 * 后端错误结构为 {"error":"..."}（GlobalExceptionHandler），拦截后直接抛 Error(message)，
 * 调用方 catch 到的即为可展示文案。
 */
const request = axios.create({
  baseURL: '/api/v1',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' }
})

request.interceptors.response.use(
  res => res.data,
  err => {
    const data = err.response?.data
    const msg = data?.error || data?.message || err.message || '请求失败'
    return Promise.reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 140)))
  }
)

export default request
