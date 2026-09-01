<script setup lang="ts">
import { computed } from 'vue'
import {
  appUpdateState,
  downloadAndInstallAppUpdate,
} from '@/services/app-updater'

const emit = defineEmits<{ close: [] }>()

const progressLabel = computed(() => {
  if (appUpdateState.phase === 'installing') return '正在安装并重启…'
  if (appUpdateState.phase === 'downloading') {
    return appUpdateState.progress == null
      ? '正在下载更新…'
      : `正在下载更新… ${appUpdateState.progress}%`
  }
  return ''
})

const busy = computed(() => (
  appUpdateState.phase === 'downloading' || appUpdateState.phase === 'installing'
))

async function installNow() {
  await downloadAndInstallAppUpdate()
}
</script>

<template>
  <div class="backend-dialog-backdrop" @mousedown.self="emit('close')">
    <section class="backend-dialog app-update-dialog" role="dialog" aria-modal="true" aria-label="发现新版本">
      <header>
        <div>
          <strong>发现新版本</strong>
          <small>Tie {{ appUpdateState.availableVersion }} 可用（当前 {{ appUpdateState.currentVersion }}）</small>
        </div>
        <button type="button" aria-label="关闭" :disabled="busy" @click="emit('close')">×</button>
      </header>
      <p v-if="appUpdateState.notes" class="app-update-notes">{{ appUpdateState.notes }}</p>
      <p v-else class="app-update-notes">建议更新以获得最新修复与功能。</p>
      <p v-if="progressLabel" class="app-update-progress">{{ progressLabel }}</p>
      <p v-if="appUpdateState.error" class="backend-error">{{ appUpdateState.error }}</p>
      <footer class="app-update-actions">
        <button type="button" :disabled="busy" @click="emit('close')">稍后</button>
        <button type="button" class="primary" :disabled="busy" @click="installNow">
          {{ busy ? '更新中…' : '立即更新' }}
        </button>
      </footer>
    </section>
  </div>
</template>
