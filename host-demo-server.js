/** 一次性极简静态服务（5500）：模拟第三方站点 serve embed-host-demo.html */
const http = require('http')
const fs = require('fs')
const path = require('path')

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }

http.createServer((req, res) => {
  const url = req.url === '/' ? '/embed-host-demo.html' : req.url
  const file = path.join(__dirname, path.normalize(url).replace(/^([/\\])+/, ''))
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404')
  }
}).listen(5500, '127.0.0.1', () => console.log('[host-demo] 第三方模拟站点: http://127.0.0.1:5500'))
