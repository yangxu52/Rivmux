export type LifecycleCommandContext = {
  generation: number
  signal: AbortSignal
}

export type LifecycleOperationResult<T> = { cancelled: true } | { cancelled: false; value: T }

export function raceLifecycleOperation<T>(operation: Promise<T>, signal: AbortSignal, onLateValue?: (value: T) => void): Promise<LifecycleOperationResult<T>> {
  if (signal.aborted) {
    void operation.then(onLateValue, () => undefined)
    return Promise.resolve({ cancelled: true })
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      void operation.then(onLateValue, () => undefined)
      resolve({ cancelled: true })
    }

    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve({ cancelled: false, value })
      },
      (error: unknown) => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
