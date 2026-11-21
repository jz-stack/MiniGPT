// ========== 对话状态管理 ==========
import { defineStore } from 'pinia'
import http from '@/api/http'
import { streamChat, type SSESource } from '@/api/sse'

export interface Message {
  id?: number
  role: 'user' | 'assistant'
  content: string
  sources?: SSESource[]
  /** 本次回答检索失败并降级为普通对话时的原因 */
  degraded?: string
  streaming?: boolean
}

export interface Conversation {
  id: number
  title: string
  createdAt?: string
}

interface State {
  conversations: Conversation[]
  currentId: number | null
  messages: Message[]
  streaming: boolean
}

export const useChatStore = defineStore('chat', {
  state: (): State => ({
    conversations: [],
    currentId: null,
    messages: [],
    streaming: false,
  }),

  actions: {
    async fetchConversations() {
      this.conversations = await http.get('/chat/conversations')
      // 默认选中第一个，没有就新建
      if (this.conversations.length === 0) {
        await this.createConversation()
      } else if (!this.currentId) {
        await this.switchConversation(this.conversations[0].id)
      }
    },

    async createConversation() {
      const conv = await http.post<Conversation>('/chat/conversations')
      this.conversations.unshift(conv)
      await this.switchConversation(conv.id)
      return conv
    },

    async switchConversation(id: number) {
      this.currentId = id
      this.messages = await http.get(`/chat/conversations/${id}/messages`)
    },

    async deleteConversation(id: number) {
      await http.delete(`/chat/conversations/${id}`)
      this.conversations = this.conversations.filter(c => c.id !== id)
      if (this.currentId === id) {
        this.messages = []
        this.currentId = null
        if (this.conversations.length) await this.switchConversation(this.conversations[0].id)
        else await this.createConversation()
      }
    },

    // 发送消息并接收流式回答
    async sendMessage(text: string, docId?: number, abortRef?: { fn: (() => void) | null }) {
      if (!this.currentId || this.streaming) return
      this.streaming = true

      // 先在界面追加用户消息 + 一个空的 AI 消息占位
      this.messages.push({ role: 'user', content: text })
      this.messages.push({ role: 'assistant', content: '', sources: [], streaming: true })

      // 关键：push 之后必须取回「响应式代理」引用再改。
      // 直接持有裸对象并修改它不会触发 Vue 更新，表现为流式过程完全不刷新、
      // 只在收尾时整段弹出（审查报告 B2）。
      const aiMsg = this.messages[this.messages.length - 1]

      const abort = await streamChat(
        { conversationId: this.currentId, message: text, docId },
        {
          onSources: sources => {
            aiMsg.sources = sources
          },
          onDegraded: reason => {
            aiMsg.degraded = reason
          },
          onDelta: delta => {
            aiMsg.content += delta
          },
          onDone: () => {
            aiMsg.streaming = false
            this.streaming = false
          },
          onError: msg => {
            aiMsg.content += aiMsg.content ? `\n\n⚠️ ${msg}` : `⚠️ ${msg}`
            aiMsg.streaming = false
            this.streaming = false
          },
        }
      )
      if (abortRef) abortRef.fn = abort
    },

    stopStreaming(abortRef?: { fn: (() => void) | null }) {
      abortRef?.fn?.()
      this.streaming = false

      const last = this.messages[this.messages.length - 1]
      if (last?.streaming) {
        last.streaming = false
        // 与后端落库的文案保持一致，避免刷新后内容前后不一致
        last.content += last.content ? '\n\n（已停止生成）' : '（已停止生成）'
      }
    },
  },
})
