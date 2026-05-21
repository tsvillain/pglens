import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ConnectionState {
  activeConnectionId: string | null
  setActive: (id: string | null) => void
}

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set) => ({
      activeConnectionId: null,
      setActive: (id) => set({ activeConnectionId: id }),
    }),
    { name: 'pglens-v3-connection' },
  ),
)
