import type { ResizeMode } from '../types'

export function resizeImage(
  source: HTMLImageElement | ImageBitmap,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  mode: ResizeMode,
): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = dstW
  canvas.height = dstH
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  if (mode === 'none') {
    // Center-crop: draw at natural size, clipping to dest
    const dx = Math.round((dstW - srcW) / 2)
    const dy = Math.round((dstH - srcH) / 2)
    ctx.drawImage(source as CanvasImageSource, dx, dy, srcW, srcH)
  } else if (mode === 'stretch') {
    ctx.drawImage(source as CanvasImageSource, 0, 0, dstW, dstH)
  } else {
    const srcRatio = srcW / srcH
    const dstRatio = dstW / dstH
    let drawW: number, drawH: number, offsetX: number, offsetY: number

    if (mode === 'cover') {
      // Scale to fill; crop the overflow
      if (srcRatio > dstRatio) {
        drawH = dstH
        drawW = drawH * srcRatio
      } else {
        drawW = dstW
        drawH = drawW / srcRatio
      }
    } else {
      // contain: fit inside with letterboxing
      if (srcRatio > dstRatio) {
        drawW = dstW
        drawH = drawW / srcRatio
      } else {
        drawH = dstH
        drawW = drawH * srcRatio
      }
      // Fill background with a neutral paper-gray letterbox
      ctx.fillStyle = '#d5d3cc'
      ctx.fillRect(0, 0, dstW, dstH)
    }

    offsetX = Math.round((dstW - drawW) / 2)
    offsetY = Math.round((dstH - drawH) / 2)
    ctx.drawImage(source as CanvasImageSource, offsetX, offsetY, drawW, drawH)
  }

  return ctx.getImageData(0, 0, dstW, dstH)
}
