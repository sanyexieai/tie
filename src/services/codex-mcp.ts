import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

export interface CodexMcpStatus {
  configured: boolean
  workspacePath: string | null
  serverPath: string | null
  configPath: string
  nodeAvailable: boolean
}

export interface SkillConnection {
  id: string
  name: string
  skillPath: string
  codexLinkPath?: string | null
  linkedAt: string
}

export interface ScannedSkill {
  name: string
  description: string
  skillPath: string
  rootPath: string
  connected: boolean
  connectionId: string | null
}

export interface SkillFile {
  name: string
  description: string
  path: string
  content: string
  connectionId: string | null
}

const prefKey = 'tie-codex-mcp-v1'

export interface CodexMcpPreference {
  sourceId: string | null
}

export function loadCodexMcpPreference(): CodexMcpPreference {
  try {
    const saved = JSON.parse(localStorage.getItem(prefKey) ?? '') as Partial<CodexMcpPreference>
    return { sourceId: typeof saved.sourceId === 'string' ? saved.sourceId : null }
  } catch {
    return { sourceId: null }
  }
}

export function saveCodexMcpPreference(pref: CodexMcpPreference) {
  localStorage.setItem(prefKey, JSON.stringify({ sourceId: pref.sourceId }))
}

export async function fetchCodexMcpStatus(): Promise<CodexMcpStatus | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null
  return invoke<CodexMcpStatus>('codex_mcp_status')
}

export async function configureCodexMcp(workspacePath: string): Promise<CodexMcpStatus> {
  return invoke<CodexMcpStatus>('configure_codex_mcp', { workspacePath })
}

export async function listSkillConnections(): Promise<SkillConnection[]> {
  return invoke<SkillConnection[]>('list_skill_connections')
}

export async function scanSkills(workspacePath?: string | null): Promise<ScannedSkill[]> {
  return invoke<ScannedSkill[]>('scan_skills', { workspacePath: workspacePath ?? null })
}

export async function listSkillScanRoots(workspacePath?: string | null): Promise<string[]> {
  return invoke<string[]>('list_skill_scan_roots', { workspacePath: workspacePath ?? null })
}

export async function listExtraSkillScanRoots(): Promise<string[]> {
  return invoke<string[]>('list_extra_skill_scan_roots')
}

export async function addSkillScanRoot(path: string): Promise<string[]> {
  return invoke<string[]>('add_skill_scan_root', { path })
}

export async function removeSkillScanRoot(path: string): Promise<string[]> {
  return invoke<string[]>('remove_skill_scan_root', { path })
}

export async function pickSkillScanDirectory(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title: '选择 Skill 扫描目录' })
  return typeof selected === 'string' ? selected : null
}

export async function connectSkill(skillPath: string): Promise<SkillConnection> {
  return invoke<SkillConnection>('connect_skill', { skillPath })
}

export async function disconnectSkill(connectionId: string): Promise<SkillConnection[]> {
  return invoke<SkillConnection[]>('disconnect_skill', { connectionId })
}

export async function readSkillFile(skillPath: string): Promise<SkillFile> {
  return invoke<SkillFile>('read_skill_file', { skillPath })
}

export async function writeSkillFile(skillPath: string, content: string): Promise<SkillFile> {
  return invoke<SkillFile>('write_skill_file', { skillPath, content })
}
