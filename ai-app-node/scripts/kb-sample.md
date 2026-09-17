# 合众智能平台部署手册（测试样例）

## 项目代号

内部代号 **凌云（LingYun）**，对外品牌"合众智能"。

## 环境要求

- Node.js ≥ 22.13
- MySQL 8.x（库名 ai_app）
- PostgreSQL 15+（可选，知识库向量存储）

## 核心端口约定

- 后端 API：**8081**
- 前端 Dev：5173
- Redis：6379（会话缓存，可选）
- Ollama 推理：11434（局域网 10.68.124.12）

## 密钥与凭据

- 数据库默认账号：admin / Zh389!qLz（仅供内网测试环境使用）
- 平台管理端初始密码：LingYun@2026，首次登录强制修改
- API 网关签名密钥存放于 /etc/lingyun/gateway.key，权限 600

## 发布流程

1. 打 tag：`release/vX.Y.Z`
2. CI 自动构建镜像 → 推送内网 Harbor（harbor.hezhong.internal/lingyun）
3. 运维平台"灰度发布"节点逐台滚动
4. 观察面板 15 分钟无告警 → 全量

## 回滚预案

Harbor 保留最近 10 个版本镜像；回滚命令：`lingyun-cli rollback --to vX.Y.Z-1`，
预计 90 秒内完成，数据库 schema 变更不随镜像回滚（需 DBA 人工评估）。
