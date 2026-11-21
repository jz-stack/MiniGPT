// ========== 系统配置状态管理 ==========
import { defineStore } from 'pinia'
import http from '@/api/http'
import { ElMessage } from 'element-plus'

interface ConfigForm {
  llmBaseUrl: string
  llmApiKey: string
  llmModel: string
  embeddingBaseUrl: string
  embeddingApiKey: string
  embeddingModel: string
  chunkSize: number
  chunkOverlap: number
  topK: number
}

/** 与后端约定的脱敏占位符 */
const MASK = '••••••••'

const empty: ConfigForm = {
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
  embeddingBaseUrl: '',
  embeddingApiKey: '',
  embeddingModel: '',
  chunkSize: 500,
  chunkOverlap: 80,
  topK: 4,
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    form: { ...empty } as ConfigForm,
    loaded: false,
  }),

  actions: {
    async fetchConfig() {
      const data = await http.get<Record<string, any>>('/config')
      // 后端数字字段以字符串返回，这里转回 number，供 el-input-number 使用
      this.form = {
        ...empty,
        ...data,
        chunkSize: Number(data.chunkSize) || empty.chunkSize,
        chunkOverlap: Number(data.chunkOverlap) || empty.chunkOverlap,
        topK: Number(data.topK) || empty.topK,
      }
      this.loaded = true
    },

    async saveConfig() {
      // 提交语义（对应审查报告 P2-2）：
      // - 未改动的脱敏字段 -> null，后端视为「保持原值」
      // - 被清空的字段     -> 空串，后端删除该配置并回退到 .env
      const payload: Record<string, string | number | null> = {}
      for (const [key, value] of Object.entries(this.form)) {
        payload[key] = value === MASK ? null : value
      }

      await http.post('/config', payload)
      ElMessage.success('配置已保存')
      await this.fetchConfig()
    },
  },
})
