import type { PlayerError, PlayerErrorKind } from 'rivmux-protocol'

export function createPlayerError(kind: PlayerErrorKind, code: string, message: string, terminal: boolean, cause?: unknown): PlayerError {
  return cause === undefined ? { kind, code, message, terminal } : { kind, code, message, terminal, cause }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function playerErrorToException(error: PlayerError): Error {
  const exception = toError(error.cause ?? error.message)
  exception.name = error.code
  return exception
}
