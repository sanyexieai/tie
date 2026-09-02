export type MobileBackContext = {
  /** 是否已在可离开应用的根界面（无下级可退） */
  onHome: () => boolean
  /** 执行应用内后退；返回 true 表示已处理 */
  goBack: () => boolean
  showLeaveHint: () => void
}

let leaveArmed = false
let leaveTimer: ReturnType<typeof setTimeout> | null = null
let handler: (() => boolean) | null = null

function clearLeaveArm() {
  leaveArmed = false
  if (leaveTimer) {
    clearTimeout(leaveTimer)
    leaveTimer = null
  }
}

/**
 * Android 系统返回 / 左侧边缘返回手势。
 * 返回 true → 让原生把任务移到后台（不杀进程）；false → 已在应用内处理。
 */
export function installMobileBackHandler(ctx: MobileBackContext) {
  handler = () => {
    if (!ctx.onHome()) {
      clearLeaveArm()
      ctx.goBack()
      return false
    }
    // 根界面：第一次提示，第二次回桌面（moveTaskToBack），绝不 exit 杀进程。
    if (!leaveArmed) {
      leaveArmed = true
      ctx.showLeaveHint()
      if (leaveTimer) clearTimeout(leaveTimer)
      leaveTimer = setTimeout(() => {
        leaveArmed = false
        leaveTimer = null
      }, 2200)
      return false
    }
    clearLeaveArm()
    return true
  }

  ;(window as Window & { __tieHandleAndroidBack?: () => boolean }).__tieHandleAndroidBack = () => handler?.() ?? false
}

export function resetMobileBackLeaveArm() {
  clearLeaveArm()
}

export function uninstallMobileBackHandler() {
  handler = null
  clearLeaveArm()
  delete (window as Window & { __tieHandleAndroidBack?: () => boolean }).__tieHandleAndroidBack
}
