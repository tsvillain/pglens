import { beforeEach, describe, expect, it } from 'vitest'

import { useConnectionStore } from '@/store/connection'

beforeEach(() => {
  useConnectionStore.setState({ activeConnectionId: null })
  // Wipe persisted state between tests.
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem('pglens-v3-connection')
  }
})

describe('useConnectionStore', () => {
  it('starts with no active connection', () => {
    expect(useConnectionStore.getState().activeConnectionId).toBeNull()
  })

  it('setActive updates the active connection id', () => {
    useConnectionStore.getState().setActive('conn-42')
    expect(useConnectionStore.getState().activeConnectionId).toBe('conn-42')
  })

  it('setActive accepts null to clear the active connection', () => {
    useConnectionStore.getState().setActive('conn-7')
    useConnectionStore.getState().setActive(null)
    expect(useConnectionStore.getState().activeConnectionId).toBeNull()
  })

  it('persists the active id to localStorage', () => {
    useConnectionStore.getState().setActive('conn-7')
    const raw = window.localStorage.getItem('pglens-v3-connection')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.state.activeConnectionId).toBe('conn-7')
  })
})
