<template>
  <div class="chat-page">
    <!-- 左侧会话列表 -->
    <div class="conv-list">
      <el-button type="primary" class="new-btn" :icon="Plus" @click="handleCreate">
        新建对话
      </el-button>
      <div class="conv-items">
        <div
          v-for="conv in chatStore.conversations"
          :key="conv.id"
          :class="['conv-item', { active: conv.id === chatStore.currentId }]"
          @click="handleSwitch(conv.id)"
        >
          <el-icon><ChatLineRound /></el-icon>
          <span class="conv-title">{{ conv.title || '新对话' }}</span>
          <el-icon class="del" @click.stop="handleDelete(conv.id)"><Delete /></el-icon>
        </div>
      </div>
    </div>

    <!-- 右侧对话区 -->
    <div class="chat-area">
      <!-- 顶部：选择文档范围 -->
      <div class="chat-header">
        <el-select
          v-model="docScope"
          placeholder="不使用知识库（普通对话）"
          clearable
          size="small"
          style="width: 260px"
        >
          <el-option
            v-for="d in readyDocs"
            :key="d.id"
            :label="d.name"
            :value="d.id"
          />
        </el-select>
        <el-tag v-if="docScope" type="success" size="small" effect="light" style="margin-left: 8px">
          RAG 模式
        </el-tag>
      </div>

      <!-- 消息列表 -->
      <div ref="msgListRef" class="msg-list">
        <div v-if="chatStore.messages.length === 0" class="welcome">
          <div class="welcome-icon">🤖</div>
          <h2>MiniGPT-KB</h2>
          <p>上传文档到知识库，然后基于文档内容提问</p>
        </div>

        <div
          v-for="(msg, i) in chatStore.messages"
          :key="i"
          :class="['msg-row', msg.role]"
        >
          <div class="avatar">{{ msg.role === 'user' ? '🧑' : '🤖' }}</div>
          <div class="bubble">
            <!-- 检索降级提示：本次回答没有用上知识库，必须让用户知道 -->
            <div v-if="msg.degraded" class="degraded">
              ⚠️ {{ msg.degraded }}，本次回答未使用知识库
            </div>
            <!-- 引用来源 -->
            <div v-if="msg.sources && msg.sources.length" class="sources">
              <div class="sources-title">📎 参考来源（{{ msg.sources.length }}）</div>
              <div v-for="(s, si) in msg.sources" :key="si" class="source-item">
                <el-tag size="small" type="warning" effect="plain">
                  {{ s.documentName }} #{{ s.chunkIndex + 1 }}
                </el-tag>
              </div>
            </div>
            <div class="content" v-html="renderMd(msg.content)"></div>
            <div v-if="msg.streaming" class="cursor">▍</div>
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="input-area">
        <div class="input-box">
          <el-input
            v-model="inputText"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 4 }"
            placeholder="输入问题，Enter 发送 / Shift+Enter 换行"
            @keydown.enter.exact.prevent="send"
          />
          <el-button
            v-if="!chatStore.streaming"
            type="primary"
            :icon="Promotion"
            circle
            @click="send"
          />
          <el-button v-else type="danger" :icon="VideoPause" circle @click="stop" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import { Plus, Promotion, VideoPause } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useChatStore } from '@/stores/chat'
import { useDocsStore } from '@/stores/docs'

// html:false 会把模型输出里的原始 HTML 转义，markdown-it 默认也会拦截 javascript: 链接，
// 因此当前不引入 DOMPurify。若将来改为 html:true，必须同时接入 HTML 净化库。
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

// 外链统一加 rel/target，避免被新窗口反向控制（审查报告 P2-8）
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer nofollow')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

const renderMd = (text: string) => md.render(text || '')

const chatStore = useChatStore()
const docsStore = useDocsStore()

const inputText = ref('')
const docScope = ref<number | undefined>(undefined)
const msgListRef = ref<HTMLElement>()
// 仅用于保存「停止生成」的函数引用，不需要响应式，因此用普通对象而非 ref
const abortRef: { fn: (() => void) | null } = { fn: null }

const readyDocs = computed(() => docsStore.documents.filter(x => x.status === 'ready'))

async function send() {
  const text = inputText.value.trim()
  if (!text || chatStore.streaming) return
  inputText.value = ''
  await chatStore.sendMessage(text, docScope.value, abortRef)
  scrollBottom()
}

function stop() {
  chatStore.stopStreaming(abortRef)
}

async function handleCreate() {
  try {
    await chatStore.createConversation()
  } catch {
    // 错误提示已由请求拦截器负责
  }
}

async function handleSwitch(id: number) {
  if (id === chatStore.currentId) return
  try {
    await chatStore.switchConversation(id)
  } catch {
    // 错误提示已由请求拦截器负责
  }
}

async function handleDelete(id: number) {
  try {
    await ElMessageBox.confirm('确定删除这个对话吗？', '提示', { type: 'warning' })
  } catch {
    return // 用户取消
  }
  try {
    await chatStore.deleteConversation(id)
  } catch {
    // 错误提示已由请求拦截器负责
  }
}

// 滚动到底部：用 requestAnimationFrame 合并同一帧内的多次触发。
// 修好流式响应后每个 token 都会触发一次 watch，不合并会明显拖慢渲染（审查报告 P2-15）
let rafId: number | null = null
function scrollBottom() {
  if (rafId !== null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    if (msgListRef.value) msgListRef.value.scrollTop = msgListRef.value.scrollHeight
  })
}

watch(() => chatStore.messages.length, scrollBottom)
watch(() => chatStore.messages[chatStore.messages.length - 1]?.content, scrollBottom)

onMounted(async () => {
  try {
    await docsStore.fetchDocuments()
    await chatStore.fetchConversations()
  } catch {
    ElMessage.error('初始化失败，请确认后端服务已启动')
  }
})
</script>

<style scoped>
.chat-page { display: flex; height: 100%; }

.conv-list {
  width: 240px;
  background: #fff;
  border-right: 1px solid #e4e7ed;
  padding: 12px;
  display: flex;
  flex-direction: column;
}
.new-btn { width: 100%; margin-bottom: 12px; }
.conv-items { flex: 1; overflow-y: auto; }
.conv-item {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-radius: 8px; cursor: pointer;
  color: #606266; font-size: 14px; margin-bottom: 4px;
}
.conv-item:hover { background: #f5f7fa; }
.conv-item.active { background: #ecf5ff; color: #409eff; }
.conv-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conv-item .del { opacity: 0; }
.conv-item:hover .del { opacity: 1; }
.conv-item .del:hover { color: #f56c6c; }

.chat-area { flex: 1; display: flex; flex-direction: column; }
.chat-header {
  padding: 12px 20px; background: #fff; border-bottom: 1px solid #e4e7ed;
  display: flex; align-items: center;
}

.msg-list { flex: 1; overflow-y: auto; padding: 24px; }
.welcome { text-align: center; color: #909399; margin-top: 15vh; }
.welcome-icon { font-size: 56px; }
.welcome h2 { color: #303133; margin: 12px 0 8px; }

.msg-row { display: flex; gap: 12px; margin-bottom: 24px; }
.msg-row.user { flex-direction: row-reverse; }
.avatar { font-size: 26px; flex-shrink: 0; }
.bubble { max-width: 75%; }
.msg-row.user .bubble { display: flex; flex-direction: column; align-items: flex-end; }

.content {
  background: #fff; padding: 12px 16px; border-radius: 10px;
  line-height: 1.7; font-size: 14px; color: #303133;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.msg-row.user .content { background: #409eff; color: #fff; }

.degraded {
  background: #fef0f0; border: 1px solid #fde2e2; color: #f56c6c;
  border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; font-size: 12px;
}
.sources {
  background: #fdf6ec; border: 1px solid #faecd8; border-radius: 8px;
  padding: 8px 12px; margin-bottom: 8px; font-size: 12px;
}
.sources-title { color: #e6a23c; margin-bottom: 6px; font-weight: 600; }
.source-item { margin: 4px 0; }
.cursor { color: #409eff; animation: blink 1s infinite; }
@keyframes blink { 50% { opacity: 0; } }

.input-area { padding: 16px 24px; background: #fff; border-top: 1px solid #e4e7ed; }
.input-box {
  display: flex; gap: 12px; align-items: flex-end;
  max-width: 900px; margin: 0 auto;
}
</style>
