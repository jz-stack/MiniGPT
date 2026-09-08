# MiniGPT-KB

基于 RAG（检索增强生成）架构的 AI 智能知识库问答系统（FastGPT 简化复刻版）。

支持文档上传、智能切分、向量化检索与流式对话，解决大模型缺乏领域知识的问题。

## 技术栈

**前端：** Vue 3 + TypeScript + Vite + Pinia + Vue Router + Naive UI

**后端：** Node.js + Express + TypeScript + Prisma

**数据与 AI：** PostgreSQL + pgvector、OpenAI 兼容接口（DeepSeek 等）、Embedding 向量化

## 目录结构

```
MiniGPT-KB/
├── frontend/   # Vue 3 前端项目
├── backend/    # Node.js 后端项目
├── docs/       # 文档、架构图、Demo 说明
└── scripts/    # 工具脚本（数据库初始化等）
```

## 核心功能（规划）

- [ ] 知识库管理：文档上传、解析（PDF/TXT/MD/DOCX）、滑动窗口切分
- [ ] 向量化入库：Embedding 生成向量，pgvector 存储
- [ ] 语义检索：向量相似度检索（后续扩展混合检索）
- [ ] RAG 对话：检索知识块 + LLM 生成，SSE 流式输出
- [ ] 多模型切换与对话参数配置
