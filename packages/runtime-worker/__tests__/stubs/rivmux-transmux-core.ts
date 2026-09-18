export const initializedWasmSources: unknown[] = []
export const initializedWasmInitArgs: unknown[] = []

export function resetInitializedWasmSources(): void {
  initializedWasmSources.length = 0
  initializedWasmInitArgs.length = 0
}

export default async function initWasmCore(options?: { module_or_path?: unknown }): Promise<void> {
  initializedWasmInitArgs.push(options)
  if (options !== undefined && (typeof options !== 'object' || options === null || !('module_or_path' in options))) {
    // eslint-disable-next-line no-console
    console.warn('using deprecated parameters for the initialization function; pass a single object instead')
  }
  initializedWasmSources.push(options?.module_or_path)
}

export class TransmuxCore {
  pushChunk(): unknown {
    return []
  }

  flush(): unknown {
    return []
  }

  reset(): void {}

  destroy(): void {}
}
