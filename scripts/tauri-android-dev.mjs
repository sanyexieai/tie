#!/usr/bin/env node
import { execSync, spawnSync } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEV_PORT = 1420

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

function runnableDevices(devices) {
  return devices.filter((device) => device.state === 'device')
}

function isBadDevHost(ip) {
  return ip.startsWith('198.18.') || ip.startsWith('127.') || ip === '0.0.0.0'
}

function pickLanHost() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    if (!ifaces) continue
    for (const net of ifaces) {
      if (net.family !== 'IPv4' || net.internal) continue
      const ip = net.address
      if (isBadDevHost(ip)) continue
      return ip
    }
  }
  return null
}

function setupAdbReverse(devices) {
  for (const device of runnableDevices(devices)) {
    try {
      execSync(`adb -s ${device.id} reverse tcp:${DEV_PORT} tcp:${DEV_PORT}`, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      console.warn(`adb reverse 失败（${device.id}），若无法加载页面可手动执行: adb -s ${device.id} reverse tcp:${DEV_PORT} tcp:${DEV_PORT}`)
    }
  }
}

function normalizeHostArgs(argv) {
  const args = [...argv]
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--host') continue
    const next = args[i + 1]
    if (!next || next.startsWith('-')) {
      const ip = pickLanHost()
      if (!ip) {
        console.error('未找到可用局域网 IP，请手动: npm run tauri:android:dev -- --host 192.168.x.x')
        process.exit(1)
      }
      args.splice(i + 1, 0, ip)
      continue
    }
    if (isBadDevHost(next)) {
      const ip = pickLanHost()
      if (ip) args[i + 1] = ip
    }
  }
  return args
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
  console.error('  2. 安装命令行模拟器：npm run android:emulator:setup && npm run android:emulator')
  console.error('  3. 仅构建 APK：npm run tauri:android:build && adb install -r ...apk')
  console.error('')
  process.exit(1)
}

setupAdbReverse(devices)

const userArgs = normalizeHostArgs(process.argv.slice(2))
const wantsLanHost = userArgs.includes('--host') || userArgs.some((arg) => arg.startsWith('--host='))

if (!wantsLanHost) {
  console.log(`已配置 adb reverse tcp:${DEV_PORT}；Vite 使用 127.0.0.1:${DEV_PORT}（模拟器/USB 调试用）`)
  console.log('WiFi 真机调试请加: npm run tauri:android:dev -- --host')
}

const result = spawnSync('npx', ['tauri', 'android', 'dev', ...userArgs], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    ...(wantsLanHost ? {} : { TAURI_DEV_HOST: undefined }),
  },
})
process.exit(result.status ?? 1)
