import '@testing-library/jest-dom/vitest'

// Zustand's `persist` middleware evaluates its storage factory once at module
// load. JSDOM's localStorage exposes its API via prototype methods, which
// some persistence helpers fail to resolve. Replacing it with a plain
// in-memory store keeps tests deterministic.
class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length() { return this.store.size }
  clear() { this.store.clear() }
  getItem(key: string) { return this.store.get(key) ?? null }
  key(i: number) { return Array.from(this.store.keys())[i] ?? null }
  removeItem(key: string) { this.store.delete(key) }
  setItem(key: string, value: string) { this.store.set(key, String(value)) }
}

const memoryLocal = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: memoryLocal,
})
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: memoryLocal,
})
