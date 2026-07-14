export const initializedWasmSources: unknown[] = []

export function resetInitializedWasmSources(): void {
  initializedWasmSources.length = 0
}

export default async function initWasmCore(source?: unknown): Promise<void> {
  initializedWasmSources.push(source)
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
