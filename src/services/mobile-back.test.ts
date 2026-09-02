import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

type TieBackWindow = Window & { __tieHandleAndroidBack?: () => boolean }

function backWindow() {
  return window as TieBackWindow
}

function installWindowStub() {
  const store: { __tieHandleAndroidBack?: () => boolean } = {}
  vi.stubGlobal('window', {
    get __tieHandleAndroidBack() {
      return store.__tieHandleAndroidBack
    },
    set __tieHandleAndroidBack(value: (() => boolean) | undefined) {
      if (value === undefined) delete store.__tieHandleAndroidBack
      else store.__tieHandleAndroidBack = value
    },
  } satisfies TieBackWindow)
}

describe('mobile-back handler contract', () => {
  beforeEach(() => {
    vi.resetModules()
    installWindowStub()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('navigates in-app when not at home and never asks native to leave', async () => {
    const { installMobileBackHandler, uninstallMobileBackHandler } = await import('@/services/mobile-back')
    const goBack = vi.fn(() => true)
    const showLeaveHint = vi.fn()
    installMobileBackHandler({
      onHome: () => false,
      goBack,
      showLeaveHint,
    })
    expect(backWindow().__tieHandleAndroidBack?.()).toBe(false)
    expect(goBack).toHaveBeenCalledOnce()
    expect(showLeaveHint).not.toHaveBeenCalled()
    uninstallMobileBackHandler()
  })

  it('arms leave on first home back and only then signals native', async () => {
    const { installMobileBackHandler, uninstallMobileBackHandler } = await import('@/services/mobile-back')
    const goBack = vi.fn(() => false)
    const showLeaveHint = vi.fn()
    installMobileBackHandler({
      onHome: () => true,
      goBack,
      showLeaveHint,
    })
    expect(backWindow().__tieHandleAndroidBack?.()).toBe(false)
    expect(showLeaveHint).toHaveBeenCalledOnce()
    expect(backWindow().__tieHandleAndroidBack?.()).toBe(true)
    uninstallMobileBackHandler()
  })

  it('clears leave arm after leaving home', async () => {
    const { installMobileBackHandler, resetMobileBackLeaveArm, uninstallMobileBackHandler } = await import('@/services/mobile-back')
    const showLeaveHint = vi.fn()
    let atHome = true
    installMobileBackHandler({
      onHome: () => atHome,
      goBack: () => true,
      showLeaveHint,
    })
    expect(backWindow().__tieHandleAndroidBack?.()).toBe(false)
    atHome = false
    resetMobileBackLeaveArm()
    expect(backWindow().__tieHandleAndroidBack?.()).toBe(false)
    atHome = true
    expect(backWindow().__tieHandleAndroidBack?.()).toBe(false)
    expect(showLeaveHint).toHaveBeenCalledTimes(2)
    uninstallMobileBackHandler()
  })
})
