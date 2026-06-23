import type { Plugin } from 'vitest/config'

type StreamState = {
  active: boolean
  opened: number
  closed: number
  chunks: number
  bytes: number
}

export function createBrowserTestServer(): Plugin {
  const streamStates = new Map<string, StreamState>()

  return {
    name: 'rivmux-browser-test-server',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost')

        if (url.pathname === '/__rivmux-test/reset') {
          streamStates.clear()
          response.writeHead(204)
          response.end()
          return
        }

        if (url.pathname === '/__rivmux-test/stats') {
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
          })
          response.end(JSON.stringify(Object.fromEntries(streamStates)))
          return
        }

        const match = /^\/__rivmux-test\/stream\/([^/]+)\.flv$/.exec(url.pathname)
        if (match === null) {
          next()
          return
        }

        const id = match[1]
        const state = getStreamState(streamStates, id)
        state.active = true
        state.opened += 1

        response.writeHead(200, {
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'content-type': 'video/x-flv',
        })

        const chunk = new Uint8Array([70, 76, 86, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0])
        const writeChunk = () => {
          if (response.writableEnded) {
            return
          }

          state.chunks += 1
          state.bytes += chunk.byteLength
          response.write(chunk)
        }

        writeChunk()
        const interval = setInterval(writeChunk, 50)
        request.on('close', () => {
          clearInterval(interval)
          state.active = false
          state.closed += 1
        })
      })
    },
  }
}

function getStreamState(streamStates: Map<string, StreamState>, id: string): StreamState {
  const existing = streamStates.get(id)
  if (existing !== undefined) {
    return existing
  }

  const state = {
    active: false,
    opened: 0,
    closed: 0,
    chunks: 0,
    bytes: 0,
  }
  streamStates.set(id, state)
  return state
}
