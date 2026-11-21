<template>
  <div class="kb-page">
    <div class="kb-inner">
      <h2 class="page-title">📚 知识库</h2>

      <!-- 上传区 -->
      <el-upload
        drag
        multiple
        :auto-upload="false"
        :show-file-list="false"
        accept=".txt,.md,.pdf,.docx"
        :on-change="handleFile"
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">拖拽文件到此处，或 <em>点击上传</em></div>
        <template #tip>
          <div class="el-upload__tip">支持 TXT / Markdown / PDF / DOCX，单文件 ≤ 20MB</div>
        </template>
      </el-upload>

      <!-- 文档表格 -->
      <el-table :data="docsStore.documents" style="margin-top: 20px" stripe>
        <el-table-column prop="name" label="文件名" min-width="240" show-overflow-tooltip />
        <el-table-column prop="fileType" label="类型" width="90" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.status === 'ready'" type="success" size="small">已完成</el-tag>
            <el-tag v-else-if="row.status === 'processing'" type="warning" size="small">
              处理中...
            </el-tag>
            <el-tooltip v-else :content="row.errorMsg" placement="top">
              <el-tag type="danger" size="small">失败</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="chunkCount" label="片段数" width="90" />
        <el-table-column prop="createdAt" label="上传时间" width="170" />
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-radio-group
              :model-value="docsStore.selectedDocId"
              size="small"
              @change="(v: any) => (docsStore.selectedDocId = v)"
            >
              <el-radio-button :value="row.id" :disabled="row.status !== 'ready'">
                {{ docsStore.selectedDocId === row.id ? '检索范围✓' : '指定检索' }}
              </el-radio-button>
            </el-radio-group>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 检索测试 -->
      <el-card class="search-card" shadow="never">
        <template #header><b>🔍 检索测试</b>（{{ docsStore.selectedDocId ? '指定文档' : '全部知识库' }}）</template>
        <div class="search-bar">
          <el-input
            v-model="query"
            placeholder="输入问题，查看最相关的文档片段"
            @keydown.enter="handleSearch"
          />
          <el-button type="primary" :loading="searching" @click="handleSearch">检索</el-button>
        </div>

        <div v-for="(r, i) in results" :key="i" class="result-item">
          <div class="result-head">
            <el-tag size="small" type="primary">#{{ i + 1 }}</el-tag>
            <span class="result-doc">{{ r.documentName }} · 片段{{ r.chunkIndex + 1 }}</span>
            <el-tag size="small" type="success">相似度 {{ (r.score * 100).toFixed(1) }}%</el-tag>
          </div>
          <div class="result-content">{{ r.content }}</div>
        </div>
        <el-empty v-if="!searching && results.length === 0 && searched" description="未检索到相关内容" />
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { UploadFilled } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useDocsStore } from '@/stores/docs'

const docsStore = useDocsStore()
const query = ref('')
const results = ref<any[]>([])
const searching = ref(false)
const searched = ref(false)

async function loadDocuments() {
  try {
    await docsStore.fetchDocuments()
  } catch {
    /* 错误已由拦截器提示 */
  }
}

async function handleFile(uploadFile: any) {
  const file = uploadFile.raw as File
  if (!file) return
  try {
    await docsStore.uploadDocument(file)
    ElMessage.success(`已上传 ${file.name}，正在后台处理`)
  } catch {
    /* 错误已由拦截器提示 */
  }
}

async function handleDelete(row: any) {
  try {
    await ElMessageBox.confirm(`确定删除《${row.name}》及其所有片段吗？`, '提示', { type: 'warning' })
  } catch {
    return // 用户取消
  }
  try {
    await docsStore.deleteDocument(row.id)
    ElMessage.success('已删除')
  } catch {
    /* 错误已由拦截器提示 */
  }
}

async function handleSearch() {
  if (!query.value.trim()) return
  searching.value = true
  try {
    results.value = await docsStore.search(query.value.trim())
    searched.value = true
  } catch {
    /* 错误已由拦截器提示 */
  } finally {
    searching.value = false
  }
}

onMounted(loadDocuments)
// 轮询定时器保存在 store 中，离开页面必须显式停止，否则会在后台持续请求（审查报告 M5）
onUnmounted(() => docsStore.stopPolling())
</script>

<style scoped>
.kb-page { height: 100%; overflow-y: auto; padding: 24px; }
.kb-inner { max-width: 1000px; margin: 0 auto; }
.page-title { margin: 0 0 20px; font-size: 22px; color: #303133; }
.search-card { margin-top: 24px; }
.search-bar { display: flex; gap: 12px; margin-bottom: 16px; }
.result-item {
  background: #f8f9fb; border-radius: 8px; padding: 12px 16px; margin-bottom: 10px;
}
.result-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.result-doc { flex: 1; font-size: 13px; color: #606266; font-weight: 600; }
.result-content { font-size: 13px; line-height: 1.7; color: #303133; white-space: pre-wrap; }
</style>
