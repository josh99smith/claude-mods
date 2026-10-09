export type Item = { id: number; category: string; text: string; done: boolean; at: string }
export type List = { next: number; items: Item[] }

declare module 'claude-code' {
  interface PluginState {
    'next-steps': { list: List; isOn: boolean; showDone: boolean; category: string; tasks: Record<string, string> }
  }
}
