import type { NormalizedRivmuxPlayerOptions, PlayerError, WorkerCommand, WorkerMessage } from '@rivmux/protocol'

export type WorkerLike = Pick<Worker, 'addEventListener' | 'postMessage' | 'removeEventListener' | 'terminate'>

export type RuntimeWorkerFactory = (options: NormalizedRivmuxPlayerOptions) => WorkerLike

type PendingRequest = {
  resolve: () => void
  reject: (error: PlayerError) => void
}

export type WorkerClientHooks = {
  onMessage(message: WorkerMessage): void
  onError(error: PlayerError): void
}

const REQUEST_TIMEOUT_MS = 5000

export class WorkerClient {
  private readonly worker: WorkerLike
  private readonly hooks: WorkerClientHooks
  private readonly handleMessage = (event: MessageEvent<WorkerMessage>): void => {
    this.handleWorkerMessage(event.data)
  }
  private readonly handleError = (event: ErrorEvent): void => {
    const error = createRuntimeWorkerError('RIVMUX_WORKER_ERROR', event.message || 'Worker runtime failed.', true, event.error)
    this.rejectAll(error)
    this.hooks.onError(error)
  }
  private pendingAttach?: PendingRequest
  private pendingStop?: PendingRequest
  private pendingDestroy?: PendingRequest
  private workerReady = false
  private queuedCommands: WorkerCommand[] = []
  private attachTimer?: ReturnType<typeof setTimeout>
  private stoppedTimer?: ReturnType<typeof setTimeout>
  private destroyedTimer?: ReturnType<typeof setTimeout>

  constructor(worker: WorkerLike, hooks: WorkerClientHooks) {
    this.worker = worker
    this.hooks = hooks
    this.worker.addEventListener('message', this.handleMessage as EventListener)
    this.worker.addEventListener('error', this.handleError as EventListener)
  }

  post(command: WorkerCommand): void {
    if (!this.workerReady) {
      this.queuedCommands.push(command)
      return
    }

    this.worker.postMessage(command)
  }

  waitForMediaSourceHandle(command: WorkerCommand): Promise<void> {
    if (this.pendingAttach !== undefined) {
      return Promise.reject(createRuntimeWorkerError('RIVMUX_ATTACH_IN_PROGRESS', 'A media source attach request is already pending.', false))
    }

    return new Promise((resolve, reject) => {
      this.pendingAttach = { resolve, reject }
      this.attachTimer = this.startTimeout('RIVMUX_ATTACH_TIMEOUT', 'Timed out waiting for worker MediaSourceHandle.', reject)
      this.post(command)
    })
  }

  waitForStopped(command: WorkerCommand): Promise<void> {
    if (this.pendingStop !== undefined) {
      return Promise.reject(createRuntimeWorkerError('RIVMUX_STOP_IN_PROGRESS', 'A stop request is already pending.', false))
    }

    return new Promise((resolve, reject) => {
      this.pendingStop = { resolve, reject }
      this.stoppedTimer = this.startTimeout('RIVMUX_STOP_TIMEOUT', 'Timed out waiting for worker stop.', reject)
      this.post(command)
    })
  }

  waitForDestroyed(command: WorkerCommand): Promise<void> {
    if (this.pendingDestroy !== undefined) {
      return Promise.reject(createRuntimeWorkerError('RIVMUX_DESTROY_IN_PROGRESS', 'A destroy request is already pending.', false))
    }

    return new Promise((resolve, reject) => {
      this.pendingDestroy = { resolve, reject }
      this.destroyedTimer = this.startTimeout('RIVMUX_DESTROY_TIMEOUT', 'Timed out waiting for worker destroy.', reject)
      this.post(command)
    })
  }

  dispose(): void {
    this.rejectAll(createRuntimeWorkerError('RIVMUX_WORKER_DISPOSED', 'Worker client was disposed.', true))
    this.worker.removeEventListener('message', this.handleMessage as EventListener)
    this.worker.removeEventListener('error', this.handleError as EventListener)
    this.worker.terminate()
  }

  private handleWorkerMessage(message: WorkerMessage): void {
    if (message.type === 'worker-ready') {
      this.flushQueuedCommands()
      return
    }

    this.hooks.onMessage(message)

    if (message.type === 'media-source-handle') {
      this.resolveAttach()
      return
    }

    if (message.type === 'stopped') {
      this.resolveStop()
      return
    }

    if (message.type === 'destroyed') {
      this.resolveDestroy()
      return
    }

    if (message.type === 'error') {
      this.rejectPendingForWorkerError(message.error)
    }
  }

  private rejectPendingForWorkerError(error: PlayerError): void {
    if (!error.terminal) {
      return
    }

    this.rejectAll(error)
  }

  private resolveAttach(): void {
    this.clearAttachTimer()
    this.pendingAttach?.resolve()
    this.pendingAttach = undefined
  }

  private resolveStop(): void {
    this.clearStoppedTimer()
    this.pendingStop?.resolve()
    this.pendingStop = undefined
  }

  private resolveDestroy(): void {
    this.clearDestroyedTimer()
    this.pendingDestroy?.resolve()
    this.pendingDestroy = undefined
  }

  private rejectAll(error: PlayerError): void {
    this.queuedCommands = []
    this.clearAttachTimer()
    this.clearStoppedTimer()
    this.clearDestroyedTimer()
    this.pendingAttach?.reject(error)
    this.pendingStop?.reject(error)
    this.pendingDestroy?.reject(error)
    this.pendingAttach = undefined
    this.pendingStop = undefined
    this.pendingDestroy = undefined
  }

  private flushQueuedCommands(): void {
    if (this.workerReady) {
      return
    }

    this.workerReady = true
    const commands = this.queuedCommands
    this.queuedCommands = []
    for (const command of commands) {
      this.worker.postMessage(command)
    }
  }

  private startTimeout(code: string, message: string, reject: (error: PlayerError) => void): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const error = createRuntimeWorkerError(code, message, true)
      reject(error)
      this.rejectAll(error)
    }, REQUEST_TIMEOUT_MS)
  }

  private clearAttachTimer(): void {
    if (this.attachTimer !== undefined) {
      clearTimeout(this.attachTimer)
      this.attachTimer = undefined
    }
  }

  private clearStoppedTimer(): void {
    if (this.stoppedTimer !== undefined) {
      clearTimeout(this.stoppedTimer)
      this.stoppedTimer = undefined
    }
  }

  private clearDestroyedTimer(): void {
    if (this.destroyedTimer !== undefined) {
      clearTimeout(this.destroyedTimer)
      this.destroyedTimer = undefined
    }
  }
}

export function createRuntimeWorker(options: NormalizedRivmuxPlayerOptions): WorkerLike {
  const url = options.runtime.workerUrl === undefined ? new URL('./rivmux-runtime-worker.js', import.meta.url) : options.runtime.workerUrl

  return new Worker(url, {
    name: 'rivmux-runtime-worker',
    type: 'module',
  })
}

function createRuntimeWorkerError(code: string, message: string, terminal: boolean, cause?: unknown): PlayerError {
  return cause === undefined ? { kind: 'runtime', code, message, terminal } : { kind: 'runtime', code, message, terminal, cause }
}
