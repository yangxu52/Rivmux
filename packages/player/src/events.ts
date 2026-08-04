import type { PlayerEventListener, PlayerEventMap, PlayerEventType } from '@rivmux/protocol'

export class PlayerEventEmitter {
  private readonly listeners = new Map<PlayerEventType, Set<PlayerEventListener<PlayerEventType>>>()

  on<T extends PlayerEventType>(type: T, listener: PlayerEventListener<T>): void {
    const typedListener = listener as PlayerEventListener<PlayerEventType>
    const listeners = this.listeners.get(type)

    if (listeners === undefined) {
      this.listeners.set(type, new Set([typedListener]))
      return
    }

    listeners.add(typedListener)
  }

  off<T extends PlayerEventType>(type: T, listener: PlayerEventListener<T>): void {
    this.listeners.get(type)?.delete(listener as PlayerEventListener<PlayerEventType>)
  }

  emit<T extends PlayerEventType>(type: T, payload: PlayerEventMap[T]): void {
    for (const listener of this.listeners.get(type) ?? []) {
      try {
        listener(payload)
      } catch (error) {
        reportListenerError(error)
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}

function reportListenerError(error: unknown): void {
  try {
    const reportError = (globalThis as typeof globalThis & { reportError?: (error: unknown) => void }).reportError
    if (typeof reportError === 'function') {
      reportError(error)
      return
    }
  } catch {
    // Fall through to the non-throwing console fallback.
  }

  try {
    globalThis.console?.error(error)
  } catch {
    // Error reporting must never affect player behavior.
  }
}
