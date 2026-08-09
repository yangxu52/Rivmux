import type { PlayerError, PlayerErrorKind } from '@rivmux/protocol'

export function createPlayerError(kind: PlayerErrorKind, code: string, message: string, terminal: boolean, cause?: unknown): PlayerError {
  return cause === undefined ? { kind, code, message, terminal } : { kind, code, message, terminal, cause: serializeCause(cause) }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function playerErrorToException(error: PlayerError): Error {
  const exception = new Error(error.message)
  exception.name = error.code
  return exception
}

function serializeCause(cause: unknown): { name: string; message: string } {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message }
  }

  if (typeof cause === 'object' && cause !== null) {
    const value = cause as { name?: unknown; message?: unknown }
    return {
      name: typeof value.name === 'string' ? value.name : 'Error',
      message: typeof value.message === 'string' ? value.message : String(cause),
    }
  }

  return { name: 'Error', message: String(cause) }
}
