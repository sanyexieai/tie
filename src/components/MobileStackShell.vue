<script setup lang="ts">
defineProps<{ title: string }>()
const emit = defineEmits<{ back: [] }>()
</script>

<template>
  <div class="mobile-stack">
    <header class="mobile-stack-header">
      <button type="button" class="mobile-stack-back" aria-label="返回" @click="emit('back')">←</button>
      <h1 class="mobile-stack-title">{{ title }}</h1>
    </header>
    <div class="mobile-stack-body">
      <slot />
    </div>
  </div>
</template>
