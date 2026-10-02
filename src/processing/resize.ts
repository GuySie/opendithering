import type { ResizeMode } from '../types'

/**
 * Computes the crop window (in source-image pixel coordinates) that cover/none
 * resize modes will show, given a crop offset within the overflow. Returns
 * null for contain/stretch, which show the whole source image and have no
 * overflow to position.
 */
export function getCropWindow(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  mode: ResizeMode,
  cropOffsetX = 0.5,
  cropOffsetY = 0.5,
): { x: number; y: number; w: number; h: number } | null {
  if (mode === 'contain' || mode === 'stretch') return null

  let visW: number, visH: number
  if (mode === 'none') {
    visW = Math.min(srcW, dstW)
    visH = Math.min(srcH, dstH)
  } else {
    // cover: scale to fill, crop whichever axis overflows
    const srcRatio = srcW / srcH
    const dstRatio = dstW / dstH
    if (srcRatio > dstRatio) {
      visH = srcH
      visW = srcH * dstRatio
    } else {
      visW = srcW
      visH = srcW / dstRatio
    }
  }

  return {
    x: (srcW - visW) * cropOffsetX,
    y: (srcH - visH) * cropOffsetY,
    w: visW,
    h: visH,
  }
}

export function resizeImage(
  source: HTMLImageElement | ImageBitmap,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  mode: ResizeMode,
  cropOffsetX = 0.5,
  cropOffsetY = 0.5,
): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = dstW
  canvas.height = dstH
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  if (mode === 'stretch') {
    ctx.drawImage(source as CanvasImageSource, 0, 0, dstW, dstH)
  } else if (mode === 'contain') {
    const srcRatio = srcW / srcH
    const dstRatio = dstW / dstH
    let drawW: number, drawH: number
    if (srcRatio > dstRatio) {
      drawW = dstW
      drawH = drawW / srcRatio
    } else {
      drawH = dstH
      drawW = drawH * srcRatio
    }
    const offsetX = Math.round((dstW - drawW) / 2)
    const offsetY = Math.round((dstH - drawH) / 2)
    // Fill background with a neutral paper-gray letterbox
    ctx.fillStyle = '#d5d3cc'
    ctx.fillRect(0, 0, dstW, dstH)
    ctx.drawImage(source as CanvasImageSource, offsetX, offsetY, drawW, drawH)
  } else {
    // cover / none: crop the chosen window out of the source, positioned by cropOffsetX/Y
    const win = getCropWindow(srcW, srcH, dstW, dstH, mode, cropOffsetX, cropOffsetY)!
    if (mode === 'cover') {
      // Scale the cropped window to exactly fill the destination
      ctx.drawImage(source as CanvasImageSource, win.x, win.y, win.w, win.h, 0, 0, dstW, dstH)
    } else {
      // none: draw at native size, centering the (possibly smaller than dst) window
      const dx = Math.round((dstW - win.w) / 2)
      const dy = Math.round((dstH - win.h) / 2)
      ctx.drawImage(source as CanvasImageSource, win.x, win.y, win.w, win.h, dx, dy, win.w, win.h)
    }
  }

  return ctx.getImageData(0, 0, dstW, dstH)
}
