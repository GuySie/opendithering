// Web Worker wrapper around dbsRefine(). The search is synchronous, so the worker can't
// process a cancel message mid-run — the main thread cancels by terminate()-ing the worker.
//
// In:  { target: ImageData, initIdx: Uint8Array, palette: Palette, params: { viewingDistanceCm, ppi, maxPasses } }
// Out: { type: 'pass', pass, accepted, E } after each pass, then { type: 'done', idx, stats }

import { dbsRefine } from './dbs'
import type { DbsParams } from './dbs'
import type { Palette } from '../types'

export interface DbsJob {
  target: ImageData
  initIdx: Uint8Array
  palette: Palette
  params: Omit<DbsParams, 'onPass'>
}

const ctx = self as unknown as Worker

ctx.onmessage = (e: MessageEvent<DbsJob>) => {
  const { target, initIdx, palette, params } = e.data
  const { idx, stats } = dbsRefine(target, initIdx, palette, {
    ...params,
    onPass: (pass, accepted, E) => ctx.postMessage({ type: 'pass', pass, accepted, E }),
  })
  ctx.postMessage({ type: 'done', idx, stats }, [idx.buffer])
}
