import type { InjectionKey, Ref } from 'vue'

export const mobilePageSwipeKey: InjectionKey<{
  openPageId: Ref<string | null>
  setOpen: (pageId: string | null) => void
}> = Symbol('mobilePageSwipe')
