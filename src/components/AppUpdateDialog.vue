<script setup lang="ts">
import { computed } from 'vue'
import {
  appUpdateState,
  downloadAndInstallAppUpdate,
  downloadAppUpdateToLocal,
  openDownloadedAppUpdate,
} from '@/services/app-updater'
import { isMobileClient } from '@/services/platform'

const emit = defineEmits<{ close: [] }>()

const progressLabel = computed(() => {
  if (appUpdateState.phase === 'installing') return '正在安装并重启…'
  if (appUpdateState.phase === 'downloaded') return '安装包已下载，可手动安装'
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

const primaryLabel = computed(() => {
  if (appUpdateState.phase === 'downloaded') return '打开安装包'
  if (appUpdateState.installMode === 'auto') return '立即更新'
  return isMobileClient.value ? '下载并安装' : '下载到本地'
})

async function installNow() {
  if (appUpdateState.phase === 'downloaded') {
    await openDownloadedAppUpdate()
    return
  }
  await downloadAndInstallAppUpdate()
}

async function downloadOnly() {
  await downloadAppUpdateToLocal()
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
      <p v-else class="app-update-notes">
        {{ appUpdateState.installMode === 'auto'
          ? '建议更新以获得最新修复与功能。自动安装失败时会自动改为下载到本地。'
          : '将下载安装包到本地，完成后请手动安装。' }}
      </p>
      <p v-if="progressLabel" class="app-update-progress">{{ progressLabel }}</p>
      <p v-if="appUpdateState.downloadedPath" class="app-update-progress">{{ appUpdateState.downloadedPath }}</p>
      <p v-if="appUpdateState.error" class="backend-error">{{ appUpdateState.error }}</p>
      <footer class="app-update-actions">
        <button type="button" :disabled="busy" @click="emit('close')">稍后</button>
        <button
          v-if="appUpdateState.phase === 'available' || appUpdateState.phase === 'error'"
          type="button"
          :disabled="busy"
          @click="downloadOnly"
        >
          仅下载
        </button>
        <button type="button" class="primary" :disabled="busy" @click="installNow">
          {{ busy ? '更新中…' : primaryLabel }}
        </button>
      </footer>
    </section>
  </div>
</template>
