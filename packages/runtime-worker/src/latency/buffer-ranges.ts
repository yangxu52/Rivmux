export type BufferedRange = {
  start: number
  end: number
}

export function normalizeBufferedRanges(input: TimeRanges | readonly BufferedRange[]): BufferedRange[] {
  if (isBufferedRangeArray(input)) {
    return input.filter(isValidRange).map((range) => ({ start: range.start, end: range.end }))
  }

  const ranges: BufferedRange[] = []
  for (let index = 0; index < input.length; index += 1) {
    const range = {
      start: input.start(index),
      end: input.end(index),
    }
    if (isValidRange(range)) {
      ranges.push(range)
    }
  }
  return ranges
}

export function getBufferedStart(ranges: readonly BufferedRange[]): number | undefined {
  return ranges.length === 0 ? undefined : ranges[0]?.start
}

export function getLiveEdge(ranges: readonly BufferedRange[]): number | undefined {
  const range = ranges[ranges.length - 1]
  return range?.end
}

export function getBufferedDuration(ranges: readonly BufferedRange[]): number | undefined {
  if (ranges.length === 0) {
    return undefined
  }

  return ranges.reduce((total, range) => total + Math.max(0, range.end - range.start), 0)
}

export function getForwardBuffer(ranges: readonly BufferedRange[], currentTime: number): number | undefined {
  if (!Number.isFinite(currentTime)) {
    return undefined
  }

  const liveEdge = getLiveEdge(ranges)
  if (liveEdge === undefined) {
    return undefined
  }

  return Math.max(0, liveEdge - currentTime)
}

export function getBackwardBuffer(ranges: readonly BufferedRange[], currentTime: number): number | undefined {
  if (!Number.isFinite(currentTime)) {
    return undefined
  }

  for (const range of ranges) {
    if (currentTime >= range.start && currentTime <= range.end) {
      return Math.max(0, currentTime - range.start)
    }
  }

  const firstRange = ranges.find((range) => currentTime < range.start)
  if (firstRange !== undefined) {
    return 0
  }

  const lastRange = ranges[ranges.length - 1]
  return lastRange === undefined ? undefined : Math.max(0, lastRange.end - lastRange.start)
}

function isValidRange(range: BufferedRange): boolean {
  return Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start
}

function isBufferedRangeArray(input: TimeRanges | readonly BufferedRange[]): input is readonly BufferedRange[] {
  return Array.isArray(input)
}
