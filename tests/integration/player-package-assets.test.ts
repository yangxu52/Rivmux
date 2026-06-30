import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import ts from 'typescript'

import { describe, expect, it } from 'vitest'

describe('published player and runtime-worker assets', () => {
  it('keeps the player package focused on the public facade', async () => {
    const playerDistDir = resolve(process.cwd(), 'packages/player/dist')
    const entries = await readdir(playerDistDir)

    await expect(assertNonEmptyFile(resolve(playerDistDir, 'index.js'))).resolves.toBeUndefined()
    expect(entries).not.toContain('rivmux-runtime-worker.js')
    expect(entries.some((entry) => entry.endsWith('.wasm'))).toBe(false)
  })

  it('ships the default worker and wasm assets from the runtime-worker package', async () => {
    const runtimeWorkerDistDir = resolve(process.cwd(), 'packages/runtime-worker/dist')
    const assets = ['index.js', 'rivmux-runtime-worker.js', 'rivmux-transmux-core.wasm']

    await expect(Promise.all(assets.map((asset) => assertNonEmptyFile(resolve(runtimeWorkerDistDir, asset))))).resolves.toBeDefined()
  })

  it('keeps the default wasm asset owned by the worker bundle', async () => {
    const { DEFAULT_RIVMUX_PLAYER_OPTIONS } = (await import('../../packages/player/dist/index.js')) as typeof import('../../packages/player/dist/index.js')

    expect(DEFAULT_RIVMUX_PLAYER_OPTIONS.runtime.wasmUrl).toBeUndefined()
  })

  it('keeps generated declarations resolvable for a consumer', async () => {
    const declarationPaths = [
      resolve(process.cwd(), 'packages/player/dist/index.d.ts'),
      resolve(process.cwd(), 'packages/runtime-worker/dist/index.d.ts'),
      resolve(process.cwd(), 'packages/runtime-worker/dist/rivmux-runtime-worker.d.ts'),
    ]
    const declarations = await Promise.all(declarationPaths.map((path) => readFile(path, 'utf8')))
    const declarationBundle = declarations.join('\n')

    expect(declarationBundle).not.toContain('from "rivmux-protocol"')
    expect(declarationBundle).toContain('from "@rivmux/protocol"')

    const diagnostics = compileConsumerTypes()

    expect(formatDiagnostics(diagnostics)).toBe('')
  })
})

async function assertNonEmptyFile(path: string): Promise<void> {
  const stats = await stat(path)
  expect(stats.isFile()).toBe(true)
  expect(stats.size).toBeGreaterThan(0)
}

function compileConsumerTypes(): readonly ts.Diagnostic[] {
  const rootFile = resolve(process.cwd(), 'tests/integration/__rivmux_consumer_typecheck__.ts')
  const source = `
    import { RivmuxPlayer, type PlayerError } from '../../packages/player/dist/index.js'

    const player: RivmuxPlayer = new RivmuxPlayer('https://example.test/live.flv')
    const handleError = (error: PlayerError): void => {
      if (error.terminal) {
        console.log(error.code)
      }
    }

    player.on('error', handleError)
  `
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2020,
  }
  const host = ts.createCompilerHost(options)
  const readHostFile = host.readFile.bind(host)
  const getHostSourceFile = host.getSourceFile.bind(host)
  const fileExists = host.fileExists.bind(host)

  host.fileExists = (fileName) => fileName === rootFile || fileExists(fileName)
  host.readFile = (fileName) => (fileName === rootFile ? source : readHostFile(fileName))
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName === rootFile) {
      return ts.createSourceFile(fileName, source, languageVersion, true)
    }

    return getHostSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  }

  const program = ts.createProgram([rootFile], options, host)
  return ts.getPreEmitDiagnostics(program)
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  if (diagnostics.length === 0) {
    return ''
  }

  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  })
}
