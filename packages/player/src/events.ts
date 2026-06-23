import type { PlayerEventListener, PlayerEventMap, PlayerEventType } from 'rivmux-protocol'

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
      listener(payload)
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
