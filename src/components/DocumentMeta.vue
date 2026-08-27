<script setup lang="ts">
defineProps<{ title: string; tags: string[]; tagDraft: string; suggestions: string[] }>()
const emit = defineEmits<{
  'update:title': [value: string]
  'update:tag-draft': [value: string]
  'add-tags': [value: string]
  'remove-tag': [tag: string]
  'select-tag': [tag: string]
  suggest: []
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
      <span v-for="tag in tags" :key="tag" class="tag tag-selectable" @click="emit('select-tag', tag)"># {{ tag }} <button :aria-label="`移除标签 ${tag}`" @click.stop="emit('remove-tag', tag)">×</button></span>
      <input :value="tagDraft" class="tag-input" placeholder="添加标签，回车确认" @input="emit('update:tag-draft', ($event.target as HTMLInputElement).value)" @keydown="completeTag" />
      <button class="tag-suggest-trigger" title="从当前标题和正文提取本地标签建议" @click="emit('suggest')">✦ 智能提取</button>
      <button v-for="tag in suggestions" :key="tag" class="tag-suggestion" @click="emit('add-tags', tag)">+ # {{ tag }}</button>
    </div>
  </div>
</template>
