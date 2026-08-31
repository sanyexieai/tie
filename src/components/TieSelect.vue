<script setup lang="ts" generic="T extends string | number | null">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface TieSelectOption<T = string | number | null> {
  value: T
  label: string
  disabled?: boolean
}

const props = defineProps<{
  modelValue: T
  options: TieSelectOption<T>[]
  ariaLabel?: string
  disabled?: boolean
  compact?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: T]; change: [value: T] }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

const selectedLabel = computed(() => {
  const hit = props.options.find((item) => Object.is(item.value, props.modelValue))
  return hit?.label ?? '请选择'
})

function toggle() {
  if (props.disabled) return
  open.value = !open.value
}

function choose(option: TieSelectOption<T>) {
  if (option.disabled) return
  emit('update:modelValue', option.value)
  emit('change', option.value)
  open.value = false
}

function onDocumentPointerDown(event: PointerEvent) {
  const target = event.target
  if (!(target instanceof Node)) return
  if (root.value?.contains(target)) return
  open.value = false
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown, true))
</script>

<template>
  <div ref="root" class="tie-select" :class="{ open, compact, disabled }">
    <button
      type="button"
      class="tie-select-trigger"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :disabled="disabled"
      @click="toggle"
    >
      <span>{{ selectedLabel }}</span>
    </button>
    <div v-if="open" class="tie-select-menu" role="listbox" :aria-label="ariaLabel">
      <button
        v-for="(option, index) in options"
        :key="`${String(option.value)}-${index}`"
        type="button"
        role="option"
        :aria-selected="Object.is(option.value, modelValue)"
        :class="{ selected: Object.is(option.value, modelValue) }"
        :disabled="option.disabled"
        @click="choose(option)"
      >{{ option.label }}</button>
    </div>
  </div>
</template>
