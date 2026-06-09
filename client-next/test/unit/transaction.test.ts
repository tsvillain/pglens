import { beforeEach, describe, expect, it } from 'vitest'

import { useTransactionStore } from '@/store/transaction'

beforeEach(() => {
  useTransactionStore.setState({ mode: {}, open: {}, connectionId: {} })
})

describe('useTransactionStore', () => {
  it('defaults to auto-commit with no open transaction', () => {
    const s = useTransactionStore.getState()
    expect(s.mode['query']).toBeUndefined() // callers treat absent as 'autocommit'
    expect(s.open['query']).toBeUndefined()
  })

  it('setMode records the mode per tab', () => {
    useTransactionStore.getState().setMode('query', 'transaction')
    expect(useTransactionStore.getState().mode['query']).toBe('transaction')
    expect(useTransactionStore.getState().mode['table:users']).toBeUndefined()
  })

  it('setOpen marks the tab open and binds it to a connection', () => {
    useTransactionStore.getState().setOpen('query', 'conn-1')
    const s = useTransactionStore.getState()
    expect(s.open['query']).toBe(true)
    expect(s.connectionId['query']).toBe('conn-1')
  })

  it('setClosed clears open + connection but keeps the mode', () => {
    const s = useTransactionStore.getState()
    s.setMode('query', 'transaction')
    s.setOpen('query', 'conn-1')

    s.setClosed('query')

    const next = useTransactionStore.getState()
    expect(next.open['query']).toBe(false)
    expect(next.connectionId['query']).toBeUndefined()
    expect(next.mode['query']).toBe('transaction')
  })

  it('reset drops all transaction state for the tab only', () => {
    const s = useTransactionStore.getState()
    s.setMode('query', 'transaction')
    s.setOpen('query', 'conn-1')
    s.setMode('table:orders', 'transaction')

    s.reset('query')

    const next = useTransactionStore.getState()
    expect(next.mode['query']).toBeUndefined()
    expect(next.open['query']).toBeUndefined()
    expect(next.connectionId['query']).toBeUndefined()
    expect(next.mode['table:orders']).toBe('transaction')
  })
})
