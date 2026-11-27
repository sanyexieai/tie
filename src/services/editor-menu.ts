export interface EditorMenuItem {
  id: string
  label: string
  shortcut?: string
  active?: boolean
  disabled?: boolean
  separator?: boolean
  children?: EditorMenuItem[]
}
