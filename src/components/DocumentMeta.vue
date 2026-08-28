<script setup lang="ts">
import { computed } from 'vue'
import type { TagSuggestion } from '@/services/tagging'

const props = defineProps<{ icon: string; title: string; tags: string[]; tagDraft: string; suggestions: TagSuggestion[]; knownTags: string[] }>()
const emit = defineEmits<{
  'update:icon': [value: string]
  'update:title': [value: string]
  'update:tag-draft': [value: string]
  'add-tags': [value: string]
  'remove-tag': [tag: string]
  'select-tag': [tag: string]
  suggest: []
  'accept-suggestions': []
}>()

function completeTag(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ',') return
  event.preventDefault()
  emit('add-tags', (event.target as HTMLInputElement).value)
}

const matchingKnownTags = computed(() => {
  const query = props.tagDraft.trim().replace(/^#\s*/, '').toLocaleLowerCase()
  if (!query) return []
  return props.knownTags
    .filter((tag) => !props.tags.some((existing) => existing.toLocaleLowerCase() === tag.toLocaleLowerCase()))
    .filter((tag) => tag.toLocaleLowerCase().includes(query))
    .slice(0, 5)
})
</script>

<template>
  <div class="editor-embedded-meta">
    <div class="document-title-row"><input :value="icon" class="document-icon-input" maxlength="4" aria-label="页面图标" placeholder="▱" @input="emit('update:icon', ($event.target as HTMLInputElement).value)" /><input :value="title" class="document-title" aria-label="页面标题" placeholder="无标题" @input="emit('update:title', ($event.target as HTMLInputElement).value)" /></div>
    <div class="tag-row">
      <span v-for="tag in tags" :key="tag" class="tag tag-selectable" @click="emit('select-tag', tag)"># {{ tag }} <button :aria-label="`移除标签 ${tag}`" @click.stop="emit('remove-tag', tag)">×</button></span>
      <input :value="tagDraft" class="tag-input" placeholder="添加标签，回车确认" @input="emit('update:tag-draft', ($event.target as HTMLInputElement).value)" @keydown="completeTag" />
      <button v-for="tag in matchingKnownTags" :key="`known-${tag}`" class="tag-known-suggestion" :title="`使用已有标签 # ${tag}`" @click="emit('add-tags', tag)">↳ # {{ tag }}</button>
      <button class="tag-suggest-trigger" title="从当前标题和正文提取本地标签建议" @click="emit('suggest')">✦ 智能提取</button>
      <button v-if="suggestions.length > 1" class="tag-accept-all" title="采纳全部推荐标签" @click="emit('accept-suggestions')">全部采纳</button>
      <button v-for="suggestion in suggestions" :key="suggestion.tag" class="tag-suggestion" :title="`${suggestion.reasons.join('；')} · 置信分 ${suggestion.score}`" @click="emit('add-tags', suggestion.tag)">+ # {{ suggestion.tag }} <small>{{ suggestion.reasons[0] }}</small></button>
    </div>
  </div>
</template>
