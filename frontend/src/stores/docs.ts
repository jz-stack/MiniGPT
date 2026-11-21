// ========== 文档（知识库）状态管理 ==========
import { defineStore } from 'pinia'
import http from '@/api/http'

export interface DocItem {
  id: number
  name: string
  fileType: string
  status: 'processing' | 'ready' | 'failed'
  chunkCount: number
  errorMsg?: string
  createdAt: string
}

interface State {
  documents: DocItem[]
  selectedDocId: number | undefined
  timer: ReturnType<typeof setTimeout> | null
  /** 已轮询次数，用于兜底上限 */
  pollCount: number
}

const POLL_INTERVAL_MS = 2000
/** 最多轮询 5 分钟：文档卡在 processing 时不再无限请求（审查报告 M5） */
const MAX_POLLS = 150

export const useDocsStore = defineStore('docs', {
  state: (): State => ({
    documents: [],
    selectedDocId: undefined,
    timer: null,
    pollCount: 0,
  }),

  actions: {
    async fetchDocuments() {
      this.documents = await http.get('/documents')
      this.syncPolling()
    },

    /** 只要还有处理中的文档就继续轮询；全部处理完后停止 */
    syncPolling() {
      const hasProcessing = this.documents.some(d => d.status === 'processing')

      if (!hasProcessing) {
        this.stopPolling()
        return
      }
      if (this.timer) return

      if (this.pollCount >= MAX_POLLS) {
        console.warn(
          `[docs] 已有文档长时间处于「处理中」，已停止自动刷新（已轮询 ${this.pollCount} 次）`
        )
        return
      }
      this.schedulePoll()
    },

    schedulePoll() {
      this.timer = setTimeout(async () => {
        this.timer = null
        this.pollCount++
        try {
          await this.fetchDocuments()
        } catch {
          // 单次请求失败不终止轮询（下一次仍会重试），错误提示由拦截器负责
          this.syncPolling()
        }
      }, POLL_INTERVAL_MS)
    },

    /** 停止轮询并复位计数，供组件卸载时调用 */
    stopPolling() {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      this.pollCount = 0
    },

    async uploadDocument(file: File) {
      const form = new FormData()
      form.append('file', file)
      // 不手动设置 Content-Type：交由浏览器生成带 boundary 的头部（审查报告 P2-14）
      await http.post('/documents/upload', form)
      await this.fetchDocuments()
    },

    async deleteDocument(id: number) {
      await http.delete(`/documents/${id}`)
      if (this.selectedDocId === id) this.selectedDocId = undefined
      await this.fetchDocuments()
    },

    // 检索测试
    async search(query: string) {
      return http.post<any[]>('/documents/search', {
        query,
        docId: this.selectedDocId,
      })
    },
  },
})
