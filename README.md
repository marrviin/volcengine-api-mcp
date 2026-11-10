# volcengine-api-mcp

把火山引擎 OpenAPI 封装为 [MCP](https://modelcontextprotocol.io) 服务，供 Claude / Cursor / Cline 等 Agent 直接调用。

## 项目结构

单包仓库：`src/lib/` 是火山各产品的 API 客户端，`src/tools/` 是 MCP 工具，`src/index.ts` 为 server 入口。

```
src/
  lib/     # API 客户端：ark（方舟生图）/ tts（语音合成）/ tos（对象存储）/ auc（语音识别）/ search（联网搜索）/ client + signer（V4 签名底座）
  tools/   # MCP 工具封装（每个文件对应一类 API）
  index.ts # MCP Server 入口（stdio 传输）
```

## 快速开始

```bash
pnpm install
pnpm build          # 构建到 dist/
pnpm dev            # 以 tsx 直接启动 MCP server（开发）
```

### 配置凭据

各工具独立取自己的环境变量（参考 `.env.example`），**不用哪个工具就不用配**；配置缺失只在调用对应工具时报错。

| 工具 | 必需 | 可选 |
| --- | --- | --- |
| `plan_images_generations` | `ARK_API_KEY`（`ark-` 开头，必须显式配置，不做其他回退） | — |
| `plan_tts_unidirectional` | 同上（复用 `ARK_API_KEY`，走方舟 Agent Plan 网关） | — |
| `tos_object_put` | `VOLC_TOS_ACCESS_KEY` / `VOLC_TOS_SECRET_KEY` / `VOLC_TOS_BUCKET` / `VOLC_TOS_REGION` | `VOLC_TOS_ENDPOINT`、`VOLC_TOS_PREFIX`（key 前缀，默认 `volcengine-api-mcp`） |
| `auc_bigmodel_transcribe` | `VOLC_ASR_API_KEY`（火山语音控制台 API Key）；传本地音频时还需 TOS 四件套（同上） | — |
| `askecho_web_search` | `ASK_ECHO_SEARCH_INFINITY_API_KEY`（搜索 API Key）或 `VOLCENGINE_ACCESS_KEY` + `VOLCENGINE_SECRET_KEY`（V4 签名）二者其一 | — |

> `VOLCENGINE_ACCESS_KEY` / `VOLCENGINE_SECRET_KEY` 除 `askecho_web_search` 的 AK/SK 鉴权模式外，也供 core 的 V4 签名客户端后续封装其他 OpenAPI 工具使用。

### 接入 Claude Code / Cursor

```json
{
  "mcpServers": {
    "volcengine-api": {
      "command": "npx",
      "args": ["-y", "volcengine-api-mcp"],
      "env": {
        "VOLCENGINE_ACCESS_KEY": "your-ak",
        "VOLCENGINE_SECRET_KEY": "your-sk",
        "VOLCENGINE_REGION": "cn-north-1",
        "ARK_API_KEY": "ark-xxx",
        "VOLC_TOS_ACCESS_KEY": "your-ak",
        "VOLC_TOS_SECRET_KEY": "your-sk",
        "VOLC_TOS_BUCKET": "your-bucket",
        "VOLC_TOS_REGION": "cn-beijing",
        "VOLC_ASR_API_KEY": "xxx"
      }
    }
  }
}
```

> `npx volcengine-api-mcp` 要求本包已发布到 npm；发布前可临时用本地路径：
> `"command": "node", "args": ["/absolute/path/to/volcengine-api-mcp/dist/index.js"]`

## 提供的工具

| 工具 | 说明 |
| --- | --- |
| `plan_images_generations` | 火山方舟文生图（`/api/plan/v3/images/generations`）：生成图片落盘并直接返回给 Agent（抽自 nova-voyage 的 ark-image.mjs 逻辑） |
| `plan_tts_unidirectional` | 豆包语音合成大模型-单向流式（`/api/v3/plan/tts/unidirectional`）：文本合成音频落盘并返回给 Agent |
| `tos_object_put` | 火山引擎 TOS 上传（Action: `PutObject`）：文件落 bucket 并返回预签名下载 URL，bucket 保持私有 |
| `auc_bigmodel_transcribe` | 大模型录音文件识别（`/api/v3/auc/bigmodel/submit` + `query`）：提交音频轮询至完成，返回全文 + 分句时间戳 + 说话人（抽自 content-forge clip 的 doubao.ts） |
| `askecho_web_search` | 联网搜索（豆包搜索，服务 `volc_torchlight_api` / Action `WebSearch`）：网页/图片搜索，支持时间/站点/行业过滤与正文返回（移植自 mcp-server 的 askecho_search_infinity） |

## 新增具体工具

在 `src/tools/` 下新建文件，参照 [tos.ts](src/tools/tos.ts)（单 API 专用工具）或 [image.ts](src/tools/image.ts)（含图片回传的处理类工具），API 客户端放 `src/lib/`：

1. 定义 `name` / `description` / zod `inputSchema` / `handler`
2. 在 [index.ts](packages/mcp-server/src/index.ts) 中 `registerTool` 注册

### 工具命名约定

统一 `服务_资源_动作`（全小写下划线），从火山 API 推导，让用户一眼对上背后调的是哪个 API：

- REST 路径类：取端点路径段，如 `/api/plan/v3/images/generations` → `plan_images_generations`
- OpenAPI Action 类：拆 Action 名，如 TOS `PutObject` → `tos_object_put`、ECS `DescribeInstances` → `ecs_describe_instances`
- 语音识别放在 `auc*` 前缀下（openspeech 的 `/api/v3/auc/...` 端点）

工具 `description` 里务必写明实际端点路径或 Action 名，方便对照文档。

> `src/lib/` 自带火山 Signature V4 签名客户端（[client.ts](src/lib/client.ts) + [signer.ts](src/lib/signer.ts)），
> 可直接调任何火山 OpenAPI（`askecho_web_search` 的 AK/SK 模式已在用）；后续封装其他 OpenAPI 工具时
> 配合 `SERVICE_HOSTS`（已映射 ecs / vpc / iam / vod / live / tls / ces）即可。
