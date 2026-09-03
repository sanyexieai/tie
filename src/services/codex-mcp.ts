import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

export type AgentClientId = 'codex' | 'cursor' | 'claude'

export interface AgentClientStatus {
  id: AgentClientId | string
  label: string
  configured: boolean
  workspacePath: string | null
  configPath: string
  error: string | null
}

export interface AgentMcpStatus {
  nodeAvailable: boolean
  mcpReady: boolean
  serverPath: string | null
  mcpError: string | null
  clients: AgentClientStatus[]
}

/** @deprecated Prefer AgentMcpStatus */
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
export const AGENT_CLIENT_OPTIONS: { id: AgentClientId; label: string; hint: string }[] = [
  { id: 'codex', label: 'Codex', hint: '~/.codex/config.toml' },
  { id: 'cursor', label: 'Cursor', hint: '~/.cursor/mcp.json' },
  { id: 'claude', label: 'Claude Code', hint: '~/.claude.json' },
]

export interface CodexMcpPreference {
  sourceId: string | null
  clients?: AgentClientId[]
}

function normalizeClients(value: unknown): AgentClientId[] {
  const allowed = new Set(AGENT_CLIENT_OPTIONS.map((item) => item.id))
  if (!Array.isArray(value)) return ['codex', 'cursor', 'claude']
  const selected = value.filter((item): item is AgentClientId => typeof item === 'string' && allowed.has(item as AgentClientId))
  return selected.length ? Array.from(new Set(selected)) : ['codex', 'cursor', 'claude']
}

export function loadCodexMcpPreference(): CodexMcpPreference {
  try {
    const saved = JSON.parse(localStorage.getItem(prefKey) ?? '') as Partial<CodexMcpPreference>
    return {
      sourceId: typeof saved.sourceId === 'string' ? saved.sourceId : null,
      clients: normalizeClients(saved.clients),
    }
  } catch {
    return { sourceId: null, clients: ['codex', 'cursor', 'claude'] }
  }
}

export function saveCodexMcpPreference(pref: CodexMcpPreference) {
  localStorage.setItem(prefKey, JSON.stringify({
    sourceId: pref.sourceId,
    clients: normalizeClients(pref.clients),
  }))
}

export async function fetchAgentMcpStatus(): Promise<AgentMcpStatus | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null
  return invoke<AgentMcpStatus>('agent_mcp_status')
}

export async function configureAgentMcp(workspacePath: string, clients: AgentClientId[]): Promise<AgentMcpStatus> {
  return invoke<AgentMcpStatus>('configure_agent_mcp', { workspacePath, clients })
}

export async function setMcpSourcePath(path: string): Promise<AgentMcpStatus> {
  return invoke<AgentMcpStatus>('set_mcp_source_path', { path })
}

/** @deprecated Prefer fetchAgentMcpStatus */
export async function fetchCodexMcpStatus(): Promise<CodexMcpStatus | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null
  return invoke<CodexMcpStatus>('codex_mcp_status')
}

/** @deprecated Prefer configureAgentMcp */
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
