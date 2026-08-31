<script setup lang="ts">
withDefaults(defineProps<{ size?: number; alt?: string }>(), {
  size: 21,
  alt: 'Tie',
})

const iconSrc = '/icon.svg'
</script>

<template>
  <img class="app-icon" :src="iconSrc" :width="size" :height="size" :alt="alt" />
</template>
