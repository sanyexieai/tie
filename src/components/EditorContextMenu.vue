<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { EditorMenuItem } from '@/services/editor-menu'

const props = defineProps<{ x: number; y: number; items: EditorMenuItem[]; formats: EditorMenuItem[] }>()
const emit = defineEmits<{ action: [id: string]; close: [restoreFocus: boolean] }>()
const root = ref<HTMLElement | null>(null)
const submenu = ref<HTMLElement | null>(null)
const openItemId = ref<string | null>(null)
const openItem = computed(() => props.items.find((item) => item.id === openItemId.value && !item.disabled && item.children?.length) ?? null)
const submenuTrigger = ref<HTMLButtonElement | null>(null)
const position = ref({ left: props.x, top: props.y })
const submenuPosition = ref({ left: 0, top: 0 })
const rootStyle = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px` }))
const submenuStyle = computed(() => ({ left: `${submenuPosition.value.left}px`, top: `${submenuPosition.value.top}px` }))

function clampPosition(element: HTMLElement, x: number, y: number) {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - element.offsetWidth - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - element.offsetHeight - 8)),
  }
}

function buttons(menu: HTMLElement | null) {
  return menu ? [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')] : []
}

function closeSubmenu(restoreFocus = false) {
  openItemId.value = null
  if (restoreFocus) submenuTrigger.value?.focus({ preventScroll: true })
}

async function openSubmenu(item: EditorMenuItem, trigger: HTMLButtonElement, focus = false) {
  if (!item.children?.length || item.disabled) return
  openItemId.value = item.id
  submenuTrigger.value = trigger
  await nextTick()
  if (!submenu.value) return
  const rect = trigger.getBoundingClientRect()
  const preferredLeft = rect.right + submenu.value.offsetWidth + 8 <= window.innerWidth
    ? rect.right + 4 : rect.left - submenu.value.offsetWidth - 4
  submenuPosition.value = clampPosition(submenu.value, preferredLeft, rect.top)
  if (focus) buttons(submenu.value)[0]?.focus({ preventScroll: true })
}

function activate(item: EditorMenuItem, event: MouseEvent) {
  if (item.disabled) return
  if (item.children?.length) {
    void openSubmenu(item, event.currentTarget as HTMLButtonElement, true)
  } else emit('action', item.id)
}

function hoverItem(item: EditorMenuItem, event: MouseEvent) {
  if (item.children?.length) void openSubmenu(item, event.currentTarget as HTMLButtonElement)
  else closeSubmenu()
}

function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement
  const inSubmenu = Boolean(submenu.value?.contains(target))
  const menu = inSubmenu ? submenu.value : root.value
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (inSubmenu || openItem.value) closeSubmenu(true)
    else emit('close', true)
    return
  }
  if (event.key === 'ArrowLeft' && openItem.value) {
    event.preventDefault()
    closeSubmenu(true)
    return
  }
  const available = buttons(menu)
  const index = available.indexOf(target as HTMLButtonElement)
  if (event.key === 'ArrowRight' && !inSubmenu) {
    const item = props.items.find((item) => item.id === target.dataset.action)
    if (item?.children) {
      event.preventDefault()
      void openSubmenu(item, target as HTMLButtonElement, true)
    }
    return
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    emit('close', true)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !available.length) return
  event.preventDefault()
  if (!inSubmenu) closeSubmenu()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
    : event.key === 'ArrowDown' ? (index + 1) % available.length
      : (index - 1 + available.length) % available.length
  available[next]?.focus({ preventScroll: true })
  available[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function onPointerDown(event: PointerEvent) {
  const target = event.target as Node | null
  if (target && (root.value?.contains(target) || submenu.value?.contains(target))) return
  emit('close', false)
}

function onViewportChange(event: Event) {
  const target = event.target
  if (target instanceof Node && (root.value?.contains(target) || submenu.value?.contains(target))) return
  emit('close', false)
}

onMounted(async () => {
  await nextTick()
  if (root.value) position.value = clampPosition(root.value, props.x, props.y)
  buttons(root.value)[0]?.focus({ preventScroll: true })
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
})
watch(() => [props.x, props.y, props.items] as const, async ([x, y], [previousX, previousY]) => {
  if (x !== previousX || y !== previousY || (openItemId.value && !openItem.value)) closeSubmenu()
  await nextTick()
  if (root.value) position.value = clampPosition(root.value, props.x, props.y)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})
</script>

<template>
  <Teleport to="body">
    <div ref="root" class="editor-context-menu editor-command-menu" role="menu" aria-label="正文编辑" :style="rootStyle"
      @keydown="onKeydown" @pointerdown.prevent @mousedown.prevent @contextmenu.prevent @wheel.stop>
      <div class="editor-menu-formats" role="group" aria-label="文字格式">
        <button v-for="item in formats" :key="item.id" type="button" role="menuitemcheckbox" :aria-label="item.label"
          :aria-checked="Boolean(item.active)" :class="{ 'is-active': item.active }" :disabled="item.disabled"
          :data-action="item.id" :title="item.shortcut ? `${item.label}（${item.shortcut}）` : item.label" @click="emit('action', item.id)">
          <strong v-if="item.id === 'bold'">B</strong><i v-else-if="item.id === 'italic'">I</i><s v-else-if="item.id === 'strike'">S</s><span v-else>&lt;/&gt;</span>
        </button>
      </div>
      <template v-for="item in items" :key="item.id">
        <div v-if="item.separator" role="separator" class="editor-menu-separator"></div>
        <button v-else type="button" role="menuitem" :aria-label="item.label" :data-action="item.id" :disabled="item.disabled"
          :aria-haspopup="item.children ? 'menu' : undefined" :aria-expanded="item.children ? openItem?.id === item.id : undefined"
          :class="{ 'is-active': item.active, 'submenu-open': openItem?.id === item.id }"
          @mouseenter="hoverItem(item, $event)" @click="activate(item, $event)">
          <span>{{ item.label }}</span><small v-if="item.children" aria-hidden="true">›</small><small v-else-if="item.shortcut">{{ item.shortcut }}</small>
        </button>
      </template>
    </div>
    <div v-if="openItem" ref="submenu" class="editor-context-menu editor-command-menu editor-command-submenu" role="menu"
      :aria-label="openItem.label" :style="submenuStyle" @keydown="onKeydown" @pointerdown.prevent @mousedown.prevent @contextmenu.prevent @wheel.stop>
      <button v-for="item in openItem.children" :key="item.id" type="button" role="menuitem" :aria-label="item.label" :data-action="item.id"
        :disabled="item.disabled" :class="{ 'is-active': item.active }" @click="emit('action', item.id)">
        <span>{{ item.label }}</span><small v-if="item.active" aria-hidden="true">✓</small><small v-else-if="item.shortcut">{{ item.shortcut }}</small>
      </button>
    </div>
  </Teleport>
</template>
