# ============================================================
# ai-agent-app 镜像（ai_app 后端——Node 运行时）
# 构建：docker build -t ai-agent-app:latest -f ai-app-node/Dockerfile .（在项目根执行）
# 运行：由 /data/compose/docker-compose.yml 的 app 服务编排（依赖 mysql8/pg16 healthy）
# 运行方式：tsx 直接跑 TS 源码（与 dev 一致——项目无独立编译产物链路，一致性优先）
# ============================================================
FROM node:22-alpine

LABEL maintainer="彭某某 <17752802756@163.com>"
LABEL org.opencontainers.image.title="ai-agent-app"
LABEL org.opencontainers.image.description="AI 智能体工作台（Vue3 + Hono + Prisma）"

WORKDIR /app

# 依赖层（缓存友好：package.json 单独 COPY）
COPY ai-app-node/package.json ai-app-node/package-lock.json* ./
RUN npm ci --registry=https://registry.npmmirror.com \
    && npm cache clean --force

# 源码 + prisma schema（generate 在启动前跑——见 CMD）
COPY ai-app-node/ ./

# 数据库 schema（宿主侧 prisma db push 也要用——此处供容器内 generate）
RUN npx prisma generate 2>/dev/null || true

EXPOSE 8081

# tsx 启动（环境变量由 compose 注入：DATABASE_URL/KB_* 等）
CMD ["npx", "tsx", "src/main.ts"]
