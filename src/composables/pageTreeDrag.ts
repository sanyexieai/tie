import type { InjectionKey, Ref } from 'vue'
import type { PageDropPosition } from '@/composables/usePageTreePointerDrag'

export const pageTreeDragKey: InjectionKey<PageTreeDragContext> = Symbol('pageTreeDrag')

export type PageTreeDragContext = {
  draggingPageId: Ref<string | null>
  dropTargetId: Ref<string | null>
  dropPosition: Ref<PageDropPosition | null>
  startPointerDrag: (event: PointerEvent, pageId: string) => void
}
