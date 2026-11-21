<template>
  <div class="settings-page">
    <div class="settings-inner">
      <h2 class="page-title">⚙️ 系统设置</h2>
      <p class="page-desc">配置 AI 模型接口与 RAG 参数，保存后立即生效（存储在后端，优先级高于 .env）。</p>

      <el-card class="card" shadow="never">
        <template #header><b>💬 对话模型（LLM）</b></template>
        <el-form label-position="top">
          <el-form-item label="API 地址（OpenAI 兼容）">
            <el-input v-model="s.form.llmBaseUrl" placeholder="https://api.deepseek.com/v1" />
          </el-form-item>
          <el-form-item label="API Key">
            <el-input v-model="s.form.llmApiKey" type="password" show-password placeholder="sk-..." />
          </el-form-item>
          <el-form-item label="模型名称">
            <el-input v-model="s.form.llmModel" placeholder="deepseek-chat" />
          </el-form-item>
        </el-form>
      </el-card>

      <el-card class="card" shadow="never">
        <template #header><b>🔢 向量模型（Embedding）</b></template>
        <el-form label-position="top">
          <el-form-item label="API 地址（OpenAI 兼容）">
            <el-input v-model="s.form.embeddingBaseUrl" placeholder="https://api.siliconflow.cn/v1" />
          </el-form-item>
          <el-form-item label="API Key">
            <el-input v-model="s.form.embeddingApiKey" type="password" show-password placeholder="sk-..." />
          </el-form-item>
          <el-form-item label="模型名称">
            <el-input v-model="s.form.embeddingModel" placeholder="BAAI/bge-m3" />
          </el-form-item>
        </el-form>
      </el-card>

      <el-card class="card" shadow="never">
        <template #header><b>🧩 RAG 参数</b></template>
        <el-form label-position="top">
          <el-form-item label="分块大小（字符数）">
            <el-input-number v-model="s.form.chunkSize" :min="100" :max="2000" :step="50" />
          </el-form-item>
          <el-form-item label="分块重叠（字符数）">
            <el-input-number v-model="s.form.chunkOverlap" :min="0" :max="500" :step="20" />
          </el-form-item>
          <el-form-item label="检索 Top-K">
            <el-input-number v-model="s.form.topK" :min="1" :max="20" />
          </el-form-item>
        </el-form>
      </el-card>

      <div class="actions">
        <el-button type="primary" size="large" @click="s.saveConfig()">保存配置</el-button>
        <el-button size="large" @click="s.fetchConfig()">重置</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useSettingsStore } from '@/stores/settings'

const s = useSettingsStore()
onMounted(() => s.fetchConfig())
</script>

<style scoped>
.settings-page { height: 100%; overflow-y: auto; padding: 24px; }
.settings-inner { max-width: 720px; margin: 0 auto; }
.page-title { margin: 0 0 8px; font-size: 22px; color: #303133; }
.page-desc { color: #909399; font-size: 13px; margin-bottom: 20px; }
.card { margin-bottom: 16px; }
.actions { display: flex; gap: 12px; margin: 20px 0; }
</style>
