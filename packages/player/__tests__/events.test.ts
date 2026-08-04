import { afterEach, describe, expect, it, vi } from 'vitest'

import { PlayerEventEmitter } from '../src/events'

describe('PlayerEventEmitter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('isolates each listener and reports failures without stopping later listeners', () => {
    const reportError = vi.fn()
    vi.stubGlobal('reportError', reportError)
    const events = new PlayerEventEmitter()
    const failure = new Error('listener failed')
    const laterListener = vi.fn()
    events.on('ready', () => {
      throw failure
    })
    events.on('ready', laterListener)

    expect(() => events.emit('ready', undefined)).not.toThrow()
    expect(reportError).toHaveBeenCalledWith(failure)
    expect(laterListener).toHaveBeenCalledOnce()
  })

  it('uses a non-throwing console fallback and removes listeners with off', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('reporting failed')
    })
    vi.stubGlobal('reportError', undefined)
    const events = new PlayerEventEmitter()
    const listener = vi.fn(() => {
      throw new Error('listener failed')
    })

    events.on('warning', listener)
    expect(() => events.emit('warning', { code: 'TEST', message: 'test' })).not.toThrow()
    expect(consoleError).toHaveBeenCalledOnce()

    events.off('warning', listener)
    events.emit('warning', { code: 'TEST', message: 'test' })
    expect(listener).toHaveBeenCalledOnce()
  })
})
