import { beforeEach, describe, expect, it } from 'vitest'

import { useTabModeStore } from '@/store/tabMode'

beforeEach(() => {
  useTabModeStore.setState({ mode: {}, sql: {} })
})

describe('useTabModeStore', () => {
  it('defaults to no mode set (treated as no-code by callers)', () => {
    expect(useTabModeStore.getState().mode['table:users']).toBeUndefined()
  })

  it('setMode records the mode per tab', () => {
    useTabModeStore.getState().setMode('table:users', 'advanced')
    expect(useTabModeStore.getState().mode['table:users']).toBe('advanced')
    expect(useTabModeStore.getState().mode['table:orders']).toBeUndefined()
  })

  it('setSql preserves edited SQL per tab', () => {
    useTabModeStore.getState().setSql('table:users', 'SELECT 1')
    expect(useTabModeStore.getState().sql['table:users']).toBe('SELECT 1')
  })

  it('reset drops both mode and sql for the tab only', () => {
    const s = useTabModeStore.getState()
    s.setMode('table:users', 'advanced')
    s.setSql('table:users', 'SELECT 1')
    s.setMode('table:orders', 'advanced')

    s.reset('table:users')

    const next = useTabModeStore.getState()
    expect(next.mode['table:users']).toBeUndefined()
    expect(next.sql['table:users']).toBeUndefined()
    expect(next.mode['table:orders']).toBe('advanced')
  })
})
