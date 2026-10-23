import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Whether the right-side AI rail is collapsed to a slim strip. Persisted so the
// choice survives reloads, like the theme/connection stores.
interface AiPanelState {
  collapsed: boolean
  setCollapsed: (v: boolean) => void
}

export const useAiPanelStore = create<AiPanelState>()(
  persist(
    (set) => ({
      collapsed: false,
      setCollapsed: (v) => set({ collapsed: v }),
    }),
    { name: 'pglens-v3-ai-panel' },
  ),
)
