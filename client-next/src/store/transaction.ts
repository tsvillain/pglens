import { create } from 'zustand'

/**
 * Per-tab transaction state (roadmap §5.3). The `[ Auto-commit | Transaction ]`
 * toggle and whether a transaction is currently open both live keyed by tab id,
 * mirroring the server-side session map. The "T" badge in the tab and the
 * close-confirmation modal read `open[tabId]`. Cleared when the tab closes.
 */
export type TxMode = 'autocommit' | 'transaction'

interface TransactionState {
  /** Active mode per tab id. Absent → 'autocommit' (the safe default). */
  mode: Record<string, TxMode>
  /** Whether a transaction is open (BEGIN issued, not yet committed/rolled back). */
  open: Record<string, boolean>
  /** Connection the open transaction is bound to — guards a connection switch. */
  connectionId: Record<string, string | undefined>
  setMode: (tabId: string, mode: TxMode) => void
  /** Record an open transaction and the connection it belongs to. */
  setOpen: (tabId: string, connectionId: string) => void
  /** Mark the transaction closed (committed / rolled back / gone). */
  setClosed: (tabId: string) => void
  /** Drop a tab's state when it closes. */
  reset: (tabId: string) => void
}

export const useTransactionStore = create<TransactionState>()((set) => ({
  mode: {},
  open: {},
  connectionId: {},
  setMode: (tabId, mode) =>
    set((s) => ({ mode: { ...s.mode, [tabId]: mode } })),
  setOpen: (tabId, connectionId) =>
    set((s) => ({
      open: { ...s.open, [tabId]: true },
      connectionId: { ...s.connectionId, [tabId]: connectionId },
    })),
  setClosed: (tabId) =>
    set((s) => ({
      open: { ...s.open, [tabId]: false },
      connectionId: { ...s.connectionId, [tabId]: undefined },
    })),
  reset: (tabId) =>
    set((s) => {
      const { [tabId]: _m, ...mode } = s.mode
      const { [tabId]: _o, ...open } = s.open
      const { [tabId]: _c, ...connectionId } = s.connectionId
      return { mode, open, connectionId }
    }),
}))
