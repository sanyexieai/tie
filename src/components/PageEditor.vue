<script setup lang="ts">
import DocumentEditor from '@/components/DocumentEditor.vue'
import EncryptedDocumentEditor from '@/components/EncryptedDocumentEditor.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { isEncryptedMarkdown } from '@/services/encrypted-markdown'
const props = defineProps<{ mobileLayout?: boolean }>()
const emit = defineEmits<{ 'toggle-sidebar': []; 'toggle-focus': []; 'toggle-context': []; 'mobile-back': [] }>()
const store = useWorkspaceStore()
const backend = useBackendStore()
</script>
<template>
  <EncryptedDocumentEditor v-if="store.activePage && isEncryptedMarkdown(store.activePage.markdown)"
    :key="`${backend.profile.endpoint}:${backend.profile.user?.id}:${store.activePage.storageSourceId}:${store.activePage.id}`" :page="store.activePage" :mobile-layout="props.mobileLayout"
    @toggle-sidebar="emit('toggle-sidebar')" @toggle-focus="emit('toggle-focus')" @toggle-context="emit('toggle-context')" @mobile-back="emit('mobile-back')" />
  <DocumentEditor v-else :mobile-layout="props.mobileLayout"
    @toggle-sidebar="emit('toggle-sidebar')" @toggle-focus="emit('toggle-focus')" @toggle-context="emit('toggle-context')" @mobile-back="emit('mobile-back')" />
</template>
