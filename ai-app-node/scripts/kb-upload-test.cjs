// 一次性 e2e 上传脚本（UTF-8 文件内联中文文件名，避开 pwsh argv 编码坑）
async function main() {
  const fd = new FormData()
  const fs = require('fs')
  fd.append('file', new Blob([fs.readFileSync('D:/work/project/MyDemo/my-ai/ai_app/ai-app-node/scripts/kb-sample.md', 'utf8')], { type: 'text/markdown' }), '凌云部署手册.md')
  const r = await fetch('http://localhost:8081/api/v1/kb/documents', { method: 'POST', body: fd })
  console.log(JSON.stringify(await r.json()))
}
main()
