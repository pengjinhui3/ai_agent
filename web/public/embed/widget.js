/**
 * 应用嵌出 widget（16 方案）：第三方页面一行引入的对话挂件加载器。
 *
 * 用法（宿主页）：
 *   <script src="http://平台:端口/embed/widget.js" data-app-key="sk_emb_xxx" defer></script>
 *
 * 行为：
 *   1. 读取 data-app-key → GET {平台}/api/v1/embed/config?key=xxx 校验
 *   2. 校验通过 → 注入右下角悬浮球（零依赖原生 CSS）
 *   3. 点击悬浮球 → 弹窗（桌面 380×600 右下角浮层 / 移动端全屏）内嵌 iframe 加载
 *      {平台}/embed/page?app_key=xxx（嵌入对话页：会话列表 + 对话核心）
 *   4. 再次点击关闭；iframe 常驻（display 切换而非销毁，保留对话上下文直到宿主页刷新）
 *   5. 校验失败（无效/吊销/域名白名单/配额）→ 控制台 warn，宿主页零干扰
 */
;(function () {
  'use strict'

  var script = document.currentScript
  if (!script) {
    var list = document.querySelectorAll('script[data-app-key]')
    script = list[list.length - 1]
  }
  if (!script) return console.warn('[widget] 未找到挂件 script 标签')

  var appKey = script.getAttribute('data-app-key')
  if (!appKey) return console.warn('[widget] 缺少 data-app-key 属性')

  // 平台地址：widget.js 自身 src 推导（支持 CDN / 反向代理部署）
  var base
  try { base = new URL('.', script.src).origin } catch (e) { return console.warn('[widget] 无法解析平台地址：', script.src) }

  var BTN_ID = '__ai_widget_fab'
  var MASK_ID = '__ai_widget_mask'
  var FRAME_ID = '__ai_widget_frame'

  var css =
    '#' + BTN_ID + '{position:fixed;right:22px;bottom:22px;width:52px;height:52px;border-radius:50%;' +
    'background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;cursor:pointer;z-index:2147483000;' +
    'box-shadow:0 4px 16px rgba(99,102,241,.4);display:flex;align-items:center;justify-content:center;' +
    'transition:transform .2s ease,box-shadow .2s ease}' +
    '#' + BTN_ID + ':hover{transform:scale(1.08);box-shadow:0 6px 22px rgba(99,102,241,.55)}' +
    '#' + BTN_ID + ' svg{width:24px;height:24px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '#' + MASK_ID + '{position:fixed;inset:0;z-index:2147482999;background:transparent;display:none}' +
    '#' + MASK_ID + '.full{background:rgba(0,0,0,.35)}' +
    '@keyframes __aiw_in{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}' +
    '#' + FRAME_ID + '{position:fixed;right:22px;bottom:86px;width:380px;height:600px;max-height:calc(100vh - 120px);' +
    'z-index:2147483001;border:1px solid #e9eaec;border-radius:14px;background:#fff;overflow:hidden;' +
    'box-shadow:0 12px 44px rgba(24,24,27,.18);animation:__aiw_in .22s ease;' +
    'transition:right .25s ease,bottom .25s ease,width .25s ease,height .25s ease}' +
    '#' + FRAME_ID + '.enlarged{right:10vw;left:10vw;top:10vh;bottom:10vh;width:80vw;height:80vh;max-height:none}' +
    '#' + FRAME_ID + ' iframe{width:100%;height:100%;border:none;display:block}' +
    '#' + FRAME_ID + ' .__aiw_ctrl{position:absolute;top:8px;right:8px;z-index:5;display:flex;gap:5px;opacity:.85}' +
    '#' + FRAME_ID + ' .__aiw_ctrl button{width:26px;height:26px;border-radius:8px;border:none;cursor:pointer;' +
    'background:rgba(255,255,255,.92);box-shadow:0 1px 4px rgba(24,24,27,.12);display:flex;align-items:center;justify-content:center;' +
    'color:#52525b;transition:background .15s,color .15s}' +
    '#' + FRAME_ID + ' .__aiw_ctrl button:hover{background:#fff;color:#18181b}' +
    '#' + FRAME_ID + ' .__aiw_ctrl svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '@media (max-width:768px){' +
    '#' + FRAME_ID + '{right:0;bottom:0;left:0;top:0;width:100%;height:100%;max-height:none;border-radius:0}' +
    '#' + FRAME_ID + '.enlarged{width:100%;height:100%;left:0;right:0;top:0;bottom:0}' +
    '#' + BTN_ID + '{right:16px;bottom:16px;width:48px;height:48px}' +
    '}'

  /** 悬浮球图标：sparkles（AI 星光，lucide 风格线性描边） */
  var ICON = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>' +
    '<path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>'

  /** 弹窗控制条图标：放大 / 还原 / 关闭（lucide maximize2 / minimize2 / x） */
  var ICON_ENLARGE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
  var ICON_RESTORE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'

  function el(id) { return document.getElementById(id) }

  function ensureCss() {
    var s = document.createElement('style')
    s.textContent = css
    document.head.appendChild(s)
  }

  /** 悬浮球（只挂一次） */
  function mountFab() {
    if (el(BTN_ID)) return
    var btn = document.createElement('button')
    btn.id = BTN_ID
    btn.type = 'button'
    btn.title = '智能助手'
    btn.innerHTML = ICON
    btn.addEventListener('click', toggle)
    document.body.appendChild(btn)
  }

  /** 弹窗 + 遮罩 + iframe + 控制条（只挂一次；open/close 只切 display，iframe 常驻保上下文） */
  var enlarged = false

  function toggleEnlarge() {
    var wrap = el(FRAME_ID)
    enlarged = !enlarged
    if (enlarged) wrap.classList.add('enlarged')
    else wrap.classList.remove('enlarged')
    // 放大/还原按钮图标切换
    var btn = wrap.querySelector('.__aiw_enlarge')
    if (btn) btn.innerHTML = enlarged ? ICON_RESTORE : ICON_ENLARGE
  }

  function mountFrame() {
    if (el(FRAME_ID)) return
    var mask = document.createElement('div')
    mask.id = MASK_ID
    if (window.matchMedia('(max-width: 768px)').matches) mask.className = 'full'
    mask.addEventListener('click', close)   // 移动端全屏遮罩可点关

    var wrap = document.createElement('div')
    wrap.id = FRAME_ID

    var iframe = document.createElement('iframe')
    iframe.src = base + '/embed/page?app_key=' + encodeURIComponent(appKey)
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write')
    wrap.appendChild(iframe)

    // 控制条（放大/还原 + 关闭；浮于 iframe 右上角）
    var ctrl = document.createElement('div')
    ctrl.className = '__aiw_ctrl'
    var enlargeBtn = document.createElement('button')
    enlargeBtn.type = 'button'
    enlargeBtn.className = '__aiw_enlarge'
    enlargeBtn.title = '放大 / 还原'
    enlargeBtn.innerHTML = ICON_ENLARGE
    enlargeBtn.addEventListener('click', toggleEnlarge)
    var closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.title = '关闭'
    closeBtn.innerHTML = ICON_CLOSE
    closeBtn.addEventListener('click', close)
    ctrl.appendChild(enlargeBtn)
    ctrl.appendChild(closeBtn)
    wrap.appendChild(ctrl)

    document.body.appendChild(mask)
    document.body.appendChild(wrap)
  }

  var open = false

  function toggle() {
    if (open) {
      el(FRAME_ID).style.display = 'none'
      el(MASK_ID).style.display = 'none'
      open = false
    } else {
      mountFrame()   // 首次打开挂载；之后仅恢复显示
      el(FRAME_ID).style.display = ''
      el(MASK_ID).style.display = ''
      open = true
    }
  }

  function close() { if (open) toggle() }

  // ---------- 启动：key 校验通过才渲染悬浮球 ----------

  function boot() {
    ensureCss()
    fetch(base + '/api/v1/embed/config?key=' + encodeURIComponent(appKey), { credentials: 'omit' })
      .then(function (r) { return r.json() })
      .then(function (cfg) {
        if (!cfg || !cfg.legal) {
          console.warn('[widget] app-key 校验未通过：', (cfg && cfg.reason) || '未知')
          return
        }
        mountFab()
      })
      .catch(function (e) { console.warn('[widget] 平台不可达：', (e && e.message) || e) })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
