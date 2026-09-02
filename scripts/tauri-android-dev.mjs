#!/usr/bin/env node
import { execSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function listAdbDevices() {
  try {
    const output = execSync('adb devices', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return output
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('*'))
      .map((line) => {
        const [id, state] = line.split(/\s+/)
        return { id, state }
      })
  } catch {
    return []
  }
}

function hasRunnableDevice(devices) {
  return devices.some((device) => device.state === 'device')
}

const devices = listAdbDevices()
if (!hasRunnableDevice(devices)) {
  console.error('\n未检测到可用的 Android 设备或模拟器（adb devices 为空或未授权）。')
  console.error('tauri android dev 需要 adb 目标；否则会尝试打开 Android Studio，无 Studio 时会报 No such file or directory。\n')
  if (devices.some((device) => device.state === 'unauthorized')) {
    console.error('已连接设备但未授权：请在手机上点「允许 USB 调试」。')
  }
  console.error('可选方案：')
  console.error('  1. USB 连接手机，开启开发者选项与 USB 调试，执行 adb devices 确认状态为 device')
  console.error('  2. 安装命令行模拟器（无需 Android Studio）：')
  console.error('     sdkmanager "emulator" "system-images;android-35;google_apis;arm64-v8a"')
  console.error('     avdmanager create avd -n tie -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_6')
  console.error('     emulator -avd tie &')
  console.error('  3. 仅构建 APK 安装到手机：npm run tauri:android:build && adb install -r ...apk')
  console.error('')
  process.exit(1)
}

const userArgs = process.argv.slice(2)
const hasHost = userArgs.includes('--host') || userArgs.some((arg) => arg.startsWith('--host'))
const tauriArgs = ['tauri', 'android', 'dev']
if (!hasHost) tauriArgs.push('--host')
tauriArgs.push(...userArgs)

const result = spawnSync('npx', tauriArgs, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
