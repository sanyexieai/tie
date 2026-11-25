interface WorkspaceStartupTasks {
  localFirst: boolean
  initializeWorkspace: () => Promise<void>
  initializeBackend: () => Promise<void>
  afterFirstPaint: () => Promise<void>
  initializeBackground: () => Promise<void>
  onBackendError: (reason: unknown) => void
  onBackgroundError: (reason: unknown) => void
}

export async function initializeWorkspaceStartup(tasks: WorkspaceStartupTasks): Promise<void> {
  if (tasks.localFirst) {
    await tasks.initializeWorkspace()
  } else {
    // Browsers need the restored account before selecting the server workspace.
    await tasks.initializeBackend()
    await tasks.initializeWorkspace()
  }

  await tasks.afterFirstPaint()
  if (tasks.localFirst) void tasks.initializeBackend().catch(tasks.onBackendError)
  void tasks.initializeBackground().catch(tasks.onBackgroundError)
}
