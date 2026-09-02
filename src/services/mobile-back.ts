import { exit } from '@tauri-apps/plugin-process'

export type MobileBackContext = {
  onHome: () => boolean
  goBack: () => void
  showExitHint: () => void
}

let exitArmed = false
let exitTimer: ReturnType<typeof setTimeout> | null = null
let handler: (() => boolean) | null = null

function clearExitArm() {
  exitArmed = false
  if (exitTimer) {
    clearTimeout(exitTimer)
    exitTimer = null
  }
}

/** 注册 Android 系统返回键 / 边缘返回手势处理（由 MainActivity 调用）。 */
export function installMobileBackHandler(ctx: MobileBackContext) {
  handler = () => {
    if (!ctx.onHome()) {
      clearExitArm()
      ctx.goBack()
      return false
    }
    if (!exitArmed) {
      exitArmed = true
      ctx.showExitHint()
      if (exitTimer) clearTimeout(exitTimer)
      exitTimer = setTimeout(() => {
        exitArmed = false
        exitTimer = null
      }, 2200)
      return false
    }
    clearExitArm()
    void exit(0)
    return true
  }

  ;(window as Window & { __tieHandleAndroidBack?: () => boolean }).__tieHandleAndroidBack = () => handler?.() ?? false
}

export function uninstallMobileBackHandler() {
  handler = null
  clearExitArm()
  delete (window as Window & { __tieHandleAndroidBack?: () => boolean }).__tieHandleAndroidBack
}
