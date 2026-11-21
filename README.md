# MiniGPT-KB · 精简版 RAG 知识库问答系统

基于 **Vue 3 + Node.js** 的检索增强生成（RAG）知识库问答系统。
灵感来自 [dreamlee0/rag-knowledge-base](https://github.com/dreamlee0/rag-knowledge-base)，在其基础上做了大幅精简，**砍掉用户系统等非核心功能，只突出 RAG 核心链路**，便于前端同学看懂、复刻和讲进简历。

---

## ✨ 核心价值（简历亮点）

| 能力 | 说明 | 技术点 |
|------|------|--------|
| 📄 文档入库 | 上传 PDF / DOCX / TXT / MD，自动解析、分块、向量化 | pdf-parse、mammoth、滑动窗口分块 |
| 🔍 语义检索 | 问题转向量，与知识库片段算余弦相似度取 Top-K | Embedding API、余弦相似度 |
| 💬 RAG 问答 | 检索片段注入 Prompt，LLM 基于知识库作答，带来源引用 | Prompt 工程、防幻觉 |
| ⚡ 流式输出 | SSE 打字机效果，前端手写 `fetch + ReadableStream` 解析 | SSE、POST 流式 |
| 🛠️ 检索调试 | 单独的「检索测试」页，可视化相似度与命中片段 | 前后端联调 |

**RAG 完整链路：**
```
上传文档 → 解析文本 → 滑动窗口分块 → Embedding 向量化 → 存入 SQLite
                                                            ↓
用户提问 → 问题向量化 → 余弦相似度检索 Top-K → 拼装 Prompt → LLM 流式回答（带引用）
```

---

## 🧱 技术栈

### 前端
- **Vue 3** + Composition API + **TypeScript**
- **Vite** 构建
- **Element Plus** UI 组件库
- **Pinia** 状态管理
- **Vue Router** 路由
- **Axios** + **markdown-it**

### 后端
- **Node.js + Express**（TypeScript，tsx 直接运行）
- **node:sqlite**（Node 内置 SQLite，Node 22+）：文档 / 片段 / 对话 / 消息 / 配置，零外部数据库依赖、无需任何原生编译
- **OpenAI SDK**：兼容 DeepSeek、硅基流动、OpenAI 等任意 OpenAI 格式接口
- 向量以 JSON 存 SQLite，内存中算余弦相似度（Demo 规模足够）

---

## 📁 目录结构

```
MiniGPT-KB/
├── backend/
│   ├── src/
│   │   ├── index.ts              # Express 入口（CORS 白名单、写操作来源校验、优雅退出）
│   │   ├── config.ts             # 环境变量配置（含上限与超时）
│   │   ├── db.ts                 # SQLite 初始化 + 表结构 + 事务/批量写入 + 配置读写
│   │   ├── errors.ts             # 可安全展示的错误类型与对外文案
│   │   ├── routes/
│   │   │   ├── documents.ts      # 文档上传/列表/删除/检索测试
│   │   │   ├── chat.ts           # 会话管理 + SSE 流式问答 ⭐
│   │   │   └── config.ts         # 运行时配置读写
│   │   └── services/
│   │       ├── parser.ts         # PDF/DOCX/TXT 解析 + 文件头校验
│   │       ├── splitter.ts       # 滑动窗口分块
│   │       ├── embedding.ts      # 文本转向量
│   │       ├── vector.ts         # 余弦相似度检索
│   │       ├── rag.ts            # RAG Prompt 组装
│   │       └── llm.ts            # LLM 流式调用
│   ├── test/                     # 回归测试（npm test）
│   ├── .env.example
│   └── package.json
└── frontend/
    ├── src/
    │   ├── App.vue               # 侧边栏布局
    │   ├── api/
    │   │   ├── http.ts           # axios 封装
    │   │   └── sse.ts            # POST SSE 客户端 ⭐
    │   ├── stores/               # Pinia: chat / docs / settings
    │   ├── views/
    │   │   ├── ChatView.vue      # AI 对话页
    │   │   ├── KnowledgeView.vue # 知识库 + 检索测试页
    │   │   └── SettingsView.vue  # 模型/参数配置页
    │   └── router/
    └── package.json
```

---

## 🚀 快速开始

> 环境要求：**Node.js 22+**（用到内置 `node:sqlite`，无需安装数据库、无需 C++ 编译环境）。

### 1. 启动后端

```bash
cd backend
npm install
cp .env.example .env      # 先可留空，Key 可在前端「系统设置」页填写
npm run dev               # 启动在 http://localhost:8000
```

### 2. 启动前端

```bash
cd frontend
npm install
npm run dev               # 启动在 http://localhost:3000
```

打开 http://localhost:3000 ，先到「系统设置」填写 API Key。

---

## 🔐 安全边界（务必阅读）

本项目**不含用户系统与鉴权**，定位是本机自用的单用户 Demo。为避免它被当作跳板，代码层面做了这些约束：

| 约束 | 说明 |
|------|------|
| 只监听回环地址 | 默认 `HOST=127.0.0.1`，局域网内其他机器访问不到。改成 `0.0.0.0` 前请确认网络可信 |
| CORS 白名单 | 只放行 `CORS_ORIGIN` 列出的来源。非白名单来源的**跨域预检不会通过**，写操作也会被 403 拒绝 |
| 写操作来源校验 | 所有非 GET 请求都会校验 `Origin`（无 Origin 的 curl / 同源部署正常放行） |
| 配置项校验 | `/api/config` 校验 URL 协议、数值范围、分块重叠与大小的关系；可用 `ALLOWED_MODEL_HOSTS` 限制模型域名 |
| 错误脱敏 | 内部异常只写入服务端日志，返回前端的是可执行的中文提示，不泄露堆栈与上游地址 |
| 输入上限 | 提问长度、文档长度、并发解析数、上传体积、Top-K 均有上限（见 `.env.example`） |

仍然存在的风险，请自行评估：

- `/api/config` **没有身份认证**：任何能访问到该端口的程序都可以改写模型地址与 API Key。所以不要把端口暴露到非可信网络。
- API Key 以**明文**保存在 `backend/data/minigpt.db`（该目录已在 `.gitignore` 中，请勿手动提交）。
- 模型 `baseUrl` 指向哪里，Key 就会以 `Authorization: Bearer` 发往哪里。`ALLOWED_MODEL_HOSTS` 留空时不做域名限制，建议长期使用或多人共用时配置它。

### 数据与文件

- 数据库：`backend/data/minigpt.db`（WAL 模式，同目录还有 `-wal` / `-shm`）
- 可用 `DATA_DIR` 改写数据目录；回归测试正是用它把数据写到隔离目录，不触碰开发库
- 上传的原始文件**不落盘**（内存缓冲解析），所以处理失败的文档只能重新上传，没有「重试」接口
- 进程启动时会把残留的 `processing` 文档标记为失败，并清理其片段，避免卡死状态与脏数据

---

## 🧪 回归测试

```bash
cd backend
npm test      # 先跑 tsc --noEmit 类型检查，再依次跑三个测试套件
```

| 套件 | 覆盖点 |
|------|--------|
| `test/splitter.test.mts` | 分块边界参数（重叠 ≥ 块大小、非法/负数/极大值）必须终止且结果正确 |
| `test/db.test.mts` | 批量写入与顺序、事务回滚与嵌套、检索只返回 ready 文档、向量维度不一致、Top-K 收敛 |
| `test/api.test.mts` | 参数校验与状态码语义、CORS 白名单、失败时消息成对落库、上传文件头校验、删除/片段的 404 |

测试通过 `DATA_DIR` 使用隔离目录 `backend/.test-data`，不会读写 `backend/data`。

---

## 🔑 API Key 配置（免费方案）

进入前端「**系统设置**」页填写，保存后存后端数据库、立即生效（无需重启）：

| 用途 | 推荐服务 | API 地址 | 模型名 | 费用 |
|------|---------|---------|--------|------|
| 对话 LLM | DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | 注册送额度，很便宜 |
| 向量 Embedding | 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `BAAI/bge-m3` | 免费 |

两者都是 **OpenAI 兼容接口**，也可以换成 OpenAI、通义千问、智谱等任何兼容服务。

---

## 📖 使用流程

1. **配置模型**：系统设置页填好 LLM 和 Embedding 的 API Key
2. **上传文档**：知识库页上传 PDF / Word / TXT / Markdown，等待状态变为「已完成」
3. **检索测试**（可选）：在知识库页底部输入问题，查看命中的片段和相似度
4. **开始问答**：对话页选择文档范围（不选则普通对话），提问后 AI 基于知识库流式回答，并标注引用来源

---

## 🛠️ 主要 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/documents/upload` | 上传文档（multipart，后台异步处理）。格式不支持 400，并发超限 429 |
| GET | `/api/documents` | 文档列表 |
| DELETE | `/api/documents/:id` | 删除文档；不存在返回 404 |
| POST | `/api/documents/search` | 语义检索测试 |
| POST | `/api/chat/send` | **流式问答（SSE）**。参数非法 400、会话/文档不存在 404、文档未处理完成 409 |
| GET/POST/DELETE | `/api/chat/conversations...` | 会话/消息管理 |
| GET/POST | `/api/config` | 读取/保存运行时配置。非法值 400，非白名单来源 403 |

> 统一响应体为 `{ code: 0, data }` 或 `{ code: 1, message }`；流式接口失败时通过 SSE 的 `error` / `degraded` 事件下发。

---

## 📝 相比原项目的精简

- ❌ 去掉用户注册/登录、JWT 鉴权（Demo 不需要）：改为「只监听本机 + CORS 白名单 + 写操作来源校验」的轻量边界，详见 [安全边界](#-安全边界务必阅读)
- ❌ 去掉本地大模型加载（改为云端 API，无需显卡和几个 GB 模型）
- ❌ 去掉 ChromaDB、Docker Compose（改用 SQLite，零依赖跑通）
- ❌ 后端从 Python 改为 **Node.js**，与前端统一语言
- ✅ 保留并突出：文档解析 → 分块 → 向量化 → 检索 → 流式问答 完整 RAG 链路

## 📌 本次修复说明

针对 `docs/代码审查报告.md` 中列出的问题做了逐项修复（阻断项 4 个、重要问题 7 个、改进建议 20 条），并补充了回归测试。几个影响最大的：

- **分块函数死循环**：`chunkOverlap >= chunkSize` 时循环不终止，实测会耗尽内存后崩溃。现在函数内钳制参数，配置接口也对「重叠必须小于块大小」做交叉校验。
- **流式渲染失效**：原实现把助手消息的裸对象存在 store 里再直接改它，Vue 收不到更新，打字机效果实际上不生效（只在结束时整段弹出）。现在改为持有响应式代理引用，并已用 Pinia 复现验证。
- **连接与数据一致性**：客户端「停止生成」时会通过 AbortSignal 中止上游请求；助手消息在正常结束、被中止、失败三种情况下都会落库，不再留下「有提问无回答」的孤立记录。
- **权限边界**：CORS 收紧为白名单、默认只监听 `127.0.0.1`、写操作校验来源、模型地址支持域名白名单、对外错误脱敏。

## License

MIT
