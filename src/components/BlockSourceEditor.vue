<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { BlockSourceSelection } from '@/services/block-source'

const props = defineProps<{
  modelValue: string
  originalMarkdown: string
  blockLabel: string
  initialSelection?: BlockSourceSelection
  error?: string
  conflicted?: boolean
  instant?: boolean
  hint?: string
}>()
const emit = defineEmits<{
  'update:modelValue': [markdown: string]
  dirty: [dirty: boolean]
  apply: []
  cancel: []
  'composition-change': [composing: boolean]
  blur: [event: FocusEvent]
  navigate: [direction: 'previous' | 'next']
  history: [action: 'undo' | 'redo']
}>()
const input = ref<HTMLTextAreaElement | null>(null)
const composing = ref(false)
const dirty = computed(() => props.modelValue !== props.originalMarkdown)

watch(dirty, (value) => emit('dirty', value), { immediate: true })
watch(() => props.modelValue, () => { void nextTick(resize) })

function resize() {
  const element = input.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.max(96, Math.min(element.scrollHeight, window.innerHeight * .6))}px`
}

function update(event: Event) {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
  resize()
}

function compositionStart() {
  composing.value = true
  emit('composition-change', true)
}

function compositionEnd(event: CompositionEvent) {
  update(event)
  composing.value = false
  emit('composition-change', false)
}

function keydown(event: KeyboardEvent) {
  if (event.isComposing || composing.value) return
  const key = event.key.toLocaleLowerCase()
  if (props.instant && (event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
    event.preventDefault()
    event.stopPropagation()
    emit('history', key === 'y' || event.shiftKey ? 'redo' : 'undo')
    return
  }
  const element = input.value
  if (props.instant && element && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    && element.selectionStart === element.selectionEnd) {
    const previous = ['ArrowUp', 'ArrowLeft'].includes(event.key) && element.selectionStart === 0
    const next = ['ArrowDown', 'ArrowRight'].includes(event.key) && element.selectionEnd === props.modelValue.length
    if (previous || next) {
      event.preventDefault()
      event.stopPropagation()
      emit('navigate', previous ? 'previous' : 'next')
      return
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    event.stopPropagation()
    if (!props.conflicted) emit('apply')
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (props.instant) emit('apply')
    else emit('cancel')
  }
}

function focusAt(from?: number, to?: number) {
  const element = input.value
  if (!element) return
  const start = from ?? props.initialSelection?.from ?? props.modelValue.length
  const end = to ?? (from === undefined ? props.initialSelection?.to ?? start : start)
  element.focus({ preventScroll: true })
  element.setSelectionRange(start, end)
}

onMounted(() => { resize(); focusAt() })
defineExpose({
  isComposing: () => composing.value,
  focusAt,
  getSelection: () => ({ from: input.value?.selectionStart ?? 0, to: input.value?.selectionEnd ?? 0 }),
})
</script>

<template>
  <section class="block-source-editor" role="region" aria-label="当前块 Markdown 源码" data-block-source-editor contenteditable="false">
    <header class="block-source-header">
      <span>{{ blockLabel }} · Markdown</span>
      <div class="block-source-actions">
        <button type="button" :disabled="composing || conflicted" title="Ctrl/Cmd + Enter" @mousedown.prevent @click="emit('apply')">{{ instant ? '完成' : '应用' }}</button>
        <button v-if="!instant" type="button" :disabled="composing" title="Esc" @mousedown.prevent @click="emit('cancel')">取消</button>
      </div>
    </header>
    <p v-if="hint" class="block-source-hint">{{ hint }}</p>
    <textarea
      ref="input"
      :value="modelValue"
      class="block-source-input"
      aria-label="当前块 Markdown 源码"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      @input="update"
      @compositionstart="compositionStart"
      @compositionend="compositionEnd"
      @keydown="keydown"
      @blur="emit('blur', $event)"
    ></textarea>
    <p v-if="error || conflicted" class="block-source-error" role="alert">{{ error || '此块已更新，源码草稿仍保留。请复制草稿后重新打开。' }}</p>
  </section>
</template>

<style scoped>
.block-source-editor { margin: 8px 0; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-elevated); color: var(--text); }
.block-source-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 10px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: 12px; }
.block-source-actions { display: flex; gap: 6px; }
.block-source-actions button { padding: 3px 9px; border: 1px solid var(--border); border-radius: 4px; background: transparent; color: var(--text); cursor: pointer; font: inherit; }
.block-source-actions button:hover:not(:disabled) { background: var(--accent-soft); }
.block-source-actions button:disabled { opacity: .45; cursor: default; }
.block-source-hint { margin: 0; padding: 6px 10px 0; color: var(--text-muted); font-size: 12px; }
.block-source-input { display: block; box-sizing: border-box; width: 100%; min-height: 96px; margin: 0; padding: 10px; border: 0; outline: none; resize: vertical; background: transparent; color: var(--text); font: 14px/1.65 var(--font-mono, monospace); tab-size: 2; white-space: pre-wrap; overflow-wrap: anywhere; }
.block-source-input:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.block-source-error { margin: 0; padding: 8px 10px; color: var(--danger, var(--text)); font-size: 12px; }
</style>
