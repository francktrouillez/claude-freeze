export type FreezeState = {
  isFrozen: boolean
  since: number | null
  parked: number
  running: number
  paused: number
  resumedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    freeze: { state: FreezeState }
  }
}
