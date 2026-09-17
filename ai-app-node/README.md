# ai-app-node — Node/TypeScript 版后端

> ai_app 的活跃后端栈（Java/Spring 版已冻结于 `dev` 分支，仅维护）。TypeScript 全栈迁移自 Java 版（12 号方案），并在此栈上完成 13 号消息结构化、02/14 号记忆模块等演进。
> 共享同一 MySQL 库（`ai_app`）与前端（`web/`，零适配切换）。

## 技术栈

| 层 | 选型 |
|----|------|
| 运行时 | Node 22 · TypeScript（strict）· tsx watch |
| Web | Hono + @hono/node-server（:8081）· SSE 流式 |
| ORM | Prisma（19 表映射，零迁移复用 Java 版库表） |
| AI | Vercel AI SDK v7（`ai` + `@ai-sdk/deepseek` + `@ai-sdk/openai` + `@ai-sdk/anthropic`） |
| 工具 | @modelcontextprotocol/sdk（streamable / stdio / sse 三传输） |
| 图标 | 前端 lucide-vue-next |

## 三协议支持

| 协议 | SDK 调用 | 说明 |
|---|---|---|
| `openai` | `createDeepSeek().chat()` → Chat Completions | 兼容性最好（GLM 官方 / Ollama / hz 网关），捕获 DeepSeek 系 `reasoning_content` 思考流 |
| `openai.responses` | `createOpenAI()` → Responses API | OpenAI 新一代端点（仅支持该 API 的网关） |
| `anthropic` | `createAnthropic()` → Messages API | 含 thinking 流；`anthropic_max_tokens` 动态配置 |

## 快速开始

```bash
# ① 依赖
npm install

# ② 环境变量（.env，库与 Java 版共享）
#    DATABASE_URL="mysql://root:123456@127.0.0.1:3306/ai_app"
#    PORT=8081

# ③ Prisma client 生成（表结构由 Java 版 schema.sql 或 DDL 文档维护）
npx prisma generate

# ④ 启动（tsx watch 热载）
npm run dev            # → http://localhost:8081/healthz

# ⑤ 前端（另一终端，连 Node 后端）
cd ../web && npm run dev:node    # API_PORT=8081 → http://localhost:5173
```

## 目录结构

```
ai-app-node/
├── src/
│   ├── agent/                  # 编排核心
│   │   ├── loop.ts             #   对话主循环：记忆拼装/技能/工具/媒体劫持/落库/摘要任务
│   │   ├── blocks.ts           #   BlockAggregator（13 号 content_blocks 聚合）
│   │   ├── events.ts           #   SSE 事件模型（8 种 ChatEvent）
│   │   └── chat-route.ts       #   POST /apps/:appCode/chat（SSE）
│   ├── llm/                     # 厂商层
│   │   ├── provider.ts         #   三协议工厂 + baseUrl 归一化 + 缓存
│   │   ├── thinking.ts         #   思考档位（字典 → effort/budget）
│   │   └── test.ts + routes.ts #   模型连通测试（测试并启用）
│   ├── tools/                   # 工具体系
│   │   ├── registry.ts         #   统一注册表：白名单匹配 + extraTools 必选直挂
│   │   ├── builtin/             #   内置工具（current_time/datetime_calc，displayName）
│   │   ├── mcp/registry.ts      #   MCP 三传输 + 连接缓存 + 连通测试
│   │   ├── skill/loader.ts      #   技能装配（注入式/目录式 load_skill）
│   │   └── memory/queries.ts    #   记忆回查工具（14 号：scope/tool_calls/media/recent）
│   ├── memory/                  # 记忆
│   │   ├── service.ts          #   会话/消息 CRUD
│   │   ├── summary.ts          #   滚动摘要（02 号：水位线/CAS/think 剥离/120s 超时）
│   │   └── attachment.ts       #   附件落盘/清理
│   ├── server/index.ts          # 全量 CRUD 路由（10 组 + 测试/运行参数）
│   ├── db/client.ts             # Prisma 单例
│   └── main.ts                  # Hono 装配（/healthz + /api/v1 + /uploads 静态）
├── prisma/schema.prisma         # 19 表映射（answer 已删 → content_blocks）
├── docs/                        # Node 版方案文档（13/14 号 + DDL 存档）
└── probe-*.ts                   # 探针脚本（AI SDK 行为实证：stream/tools/reasoning/maxTokens/mcp）
```

## 能力速览

- **SSE 8 事件**（MESSAGE/THINKING/TOOL_START/TOOL_RESULT/MEDIA_START/MEDIA_END/DONE/ERROR），断流半截落库
- **三协议思考流**：OpenAI reasoning_content / Anthropic thinking / Responses API
- **content_blocks 结构化消息**（13 号）：thinking/text/tool_use/tool_result/media 五类块（对齐 Anthropic content block），回放零解析
- **媒体劫持**（09 号）：正文流检测 ` ```echarts ` → MEDIA 模式 → media 块 + media_json，脏数据/半截降级
- **工具循环**：`stopWhen: stepCountIs(agent_max_steps)`（动态配置，v7 API）；displayName 展示名 / toolCallId 配对计时 / 错误文本识别标红
- **滚动摘要**（02 号）：水位线触发（`memory_summary_trigger_chars`）/ 增量合并 / CAS 并发安全 / 基础模型未配置静默降级
- **记忆回查**（14 号）：摘要只记出处（来源消息 #N），4 个闭包会话绑定工具按需精查原始数据；[#N] 前缀直达
- **动态配置**：8 个内置键（agent_max_steps / anthropic_max_tokens / memory_summary_trigger_chars 等），改完即时生效

## 探针脚本（实证驱动开发）

| 脚本 | 验证内容 |
|---|---|
| `probe-stream.ts` | AI SDK streamText 基础行为 |
| `probe-anthropic.ts` | anthropic provider + baseURL /v1 归一化 |
| `probe-reasoning.ts` | reasoning_content 捕获（openai vs deepseek provider 差异） |
| `probe-tools.ts` | tools 格式 + stopWhen 多步循环 + 全事件流 |
| `probe-toolchain.ts` | getTools 白名单匹配 + 技能装配 |
| `probe-max-tokens.ts` | maxOutputTokens → 请求体 max_tokens 映射 |
| `probe-mcp-market.ts` | Streamable HTTP MCP 连通 |

## 文档

- 方案文档：[docs/](docs/)（13 号 content_blocks / 14 号记忆回溯 / DDL 存档）
- 根目录 [../docs/README.md](../docs/README.md)：全项目文档索引
