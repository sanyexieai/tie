<script setup lang="ts">
defineProps<{ title: string; tags: string[]; tagDraft: string }>()
const emit = defineEmits<{
  'update:title': [value: string]
  'update:tag-draft': [value: string]
  'add-tags': [value: string]
  'remove-tag': [tag: string]
}>()

function completeTag(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ',') return
  event.preventDefault()
  emit('add-tags', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="editor-embedded-meta">
    <input :value="title" class="document-title" aria-label="页面标题" placeholder="无标题" @input="emit('update:title', ($event.target as HTMLInputElement).value)" />
    <div class="tag-row">
      <span v-for="tag in tags" :key="tag" class="tag"># {{ tag }} <button :aria-label="`移除标签 ${tag}`" @click="emit('remove-tag', tag)">×</button></span>
      <input :value="tagDraft" class="tag-input" placeholder="添加标签，回车确认" @input="emit('update:tag-draft', ($event.target as HTMLInputElement).value)" @keydown="completeTag" />
    </div>
  </div>
</template>
