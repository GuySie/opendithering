import type { ProcessingSettings, ResizeMode, PresetName, ImageFile } from './types'
import { PRESETS, BALANCED_PRESET } from './types'
import { DISPLAY_PRESETS } from './displays/presets'
import { getAllPaletteGroups, getPaletteGroup, getPaletteVariant } from './palettes/index'
import { getAllAlgorithms } from './dithering/index'
import { runPipeline } from './processing/pipeline'
import { colorTune } from './processing/colortune'
import { hueTune } from './processing/huetune'
import { autoExpose } from './processing/autoexpose'
import type { ColorTuneDebug } from './processing/colortune'
import type { HueTuneDebug } from './processing/huetune'
import type { AutoExposeDebug } from './processing/autoexpose'
import { isSupported as bleIsSupported, connectDevice as bleConnect, encodeImage as bleEncode, sendImage as bleSend } from './ble/opendisplay'
import { isSupported as giciskyIsSupported, connectDevice as giciskyConnect, encodeImage as giciskyEncode, sendImage as gickySend, getDeviceInfoForPreset as giciskyDeviceInfo } from './ble/gicisky'
import type { GiciskyConnection } from './ble/gicisky'

// ── State ──────────────────────────────────────────────────────────────────

let images: ImageFile[] = []
let activeId: string | null = null
let settings: ProcessingSettings = { ...BALANCED_PRESET }
let resizeMode: ResizeMode = 'cover'
let displayWidth = 800
let displayHeight = 480
let paletteGroupId       = 'spectra6'
let calibrationVariantId = 'spectra6-wenting'
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let showIdealPreview = false
let activePreset: Exclude<PresetName, 'custom'> = 'balanced'
let bleProtocol: 'opendisplay' | 'gicisky' = 'opendisplay'
type BleState =
  | { protocol: 'opendisplay'; char: BluetoothRemoteGATTCharacteristic }
  | { protocol: 'gicisky';     conn: GiciskyConnection }
  | null
let bleState: BleState = null

// ── DOM refs ──────────────────────────────────────────────────────────────

const dropZone         = el<HTMLDivElement>('dropZone')
const fileInput        = el<HTMLInputElement>('fileInput')
const thumbnailStrip   = el<HTMLDivElement>('thumbnailStrip')
const presetSelect     = el<HTMLSelectElement>('presetSelect')
const presetLabel      = el<HTMLSpanElement>('presetLabel')
const presetTrigger    = el<HTMLButtonElement>('presetTrigger')
const customDims       = el<HTMLDivElement>('customDims')
const dimWidth         = el<HTMLInputElement>('dimWidth')
const dimHeight        = el<HTMLInputElement>('dimHeight')
const paletteSelect       = el<HTMLSelectElement>('paletteSelect')
const calibrationSelect   = el<HTMLSelectElement>('calibrationSelect')
const paletteSwatches     = el<HTMLDivElement>('paletteSwatches')
const resizeModeSelect = el<HTMLSelectElement>('resizeMode')
const toneModeSelect   = el<HTMLSelectElement>('toneMode')
const panelContrast    = el<HTMLDivElement>('panelContrast')
const panelScurve      = el<HTMLDivElement>('panelScurve')
const algorithmSelect     = el<HTMLSelectElement>('algorithmSelect')
const panelKnoxAlpha      = el<HTMLDivElement>('panelKnoxAlpha')
const panelRiemersmaQueue = el<HTMLDivElement>('panelRiemersmaQueue')
const panelDizzyDiagonal  = el<HTMLDivElement>('panelDizzyDiagonal')
const panelColorMatching  = el<HTMLDivElement>('panelColorMatching')
const panelLocalVariance  = el<HTMLDivElement>('panelLocalVariance')
const panelSerpentine     = el<HTMLDivElement>('panelSerpentine')
const serpentineCheck     = el<HTMLInputElement>('serpentineCheck')
const SERPENTINE_ALGORITHMS = new Set(['floyd-steinberg', 'atkinson', 'burkes', 'jarvis', 'sierra', 'stucki', 'knox'])
const colorPresetSel      = el<HTMLSelectElement>('colorPreset')
const errorSpaceSel       = el<HTMLSpanElement>('errorSpaceSel')
const distSpaceSel        = el<HTMLSpanElement>('distSpaceSel')
const colorSpaceLabel: Record<string, string> = { rgb: 'RGB', cielab: 'CIELAB', oklab: 'OKLab', 'oklab-chroma': 'OKLab chroma-aware' }
const localVarianceCheck  = el<HTMLInputElement>('localVarianceDetection')
const expandPaletteCheck  = el<HTMLInputElement>('expandPalette')
const canvasOrig       = el<HTMLCanvasElement>('canvasOriginal')
const canvasDith       = el<HTMLCanvasElement>('canvasDithered')
const viewportOrig     = el<HTMLDivElement>('viewportOrig')
const viewportDith     = el<HTMLDivElement>('viewportDith')
const emptyState       = el<HTMLDivElement>('emptyState')
const previewPanels    = el<HTMLDivElement>('previewPanels')
const procOverlay      = el<HTMLDivElement>('processingOverlay')
const paletteBadge         = el<HTMLSpanElement>('paletteBadge')
const ditheredPanelLabel   = el<HTMLSpanElement>('ditheredPanelLabel')
const previewToggleBtns    = Array.from(document.querySelectorAll<HTMLButtonElement>('.preview-toggle-btn'))
const btnDownloadMain  = el<HTMLButtonElement>('btnDownloadMain')
const btnDownloadArrow = el<HTMLButtonElement>('btnDownloadArrow')
const splitDownloadMenu = el<HTMLDivElement>('splitDownloadMenu')
const btnDownloadZip   = el<HTMLButtonElement>('btnDownloadZip')
const btnUploadDevice       = el<HTMLButtonElement>('btnUploadDevice')
const btnUploadDeviceArrow  = el<HTMLButtonElement>('btnUploadDeviceArrow')
const splitUploadMenu       = el<HTMLDivElement>('splitUploadMenu')
const btnConnectDevice        = el<HTMLButtonElement>('btnConnectDevice')
const btnDisconnectDevice     = el<HTMLButtonElement>('btnDisconnectDevice')
const btnProtocolOpenDisplay  = el<HTMLButtonElement>('btnProtocolOpenDisplay')
const btnProtocolGicisky      = el<HTMLButtonElement>('btnProtocolGicisky')
const bleStatus             = el<HTMLParagraphElement>('bleStatus')
const bleStatusText         = el<HTMLSpanElement>('bleStatusText')
const bleCompatHint         = el<HTMLParagraphElement>('bleCompatHint')
const bleRotation           = el<HTMLSelectElement>('bleRotation')
const rotationWarn          = el<HTMLParagraphElement>('rotationWarn')

;(() => {
  function browserName(): string {
    if ((navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData) {
      const brands = (navigator as Navigator & { userAgentData: { brands: { brand: string }[] } }).userAgentData.brands
      if (brands.some(b => b.brand === 'Microsoft Edge')) return 'Edge'
      if (brands.some(b => b.brand === 'Google Chrome')) return 'Chrome'
      if (brands.some(b => b.brand === 'Chromium')) return 'Chromium'
    }
    const ua = navigator.userAgent
    if (ua.includes('Firefox')) return 'Firefox'
    if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari'
    if (ua.includes('Edg/')) return 'Edge'
    if (ua.includes('Chrome')) return 'Chrome'
    return 'your browser'
  }
  const name = browserName()
  bleCompatHint.textContent = navigator.bluetooth
    ? `BLE upload is supported in ${name}.`
    : `BLE upload is not supported in ${name}. Try Chrome or Edge.`
})()
const checkCDR         = el<HTMLInputElement>('checkCDR')
const btnAutoTune      = el<HTMLButtonElement>('btnAutoTune')
const btnColorTune     = el<HTMLButtonElement>('btnColorTune')
const btnHueTune       = el<HTMLButtonElement>('btnHueTune')
const btnAutoExpose    = el<HTMLButtonElement>('btnAutoExpose')
const debugAutoExpose  = el<HTMLDivElement>('debugAutoExpose')
const debugColorTune   = el<HTMLDivElement>('debugColorTune')
const debugHueTune     = el<HTMLDivElement>('debugHueTune')
const dbgSummary       = el<HTMLSpanElement>('dbgSummary')
const dbgRefC          = el<HTMLTableCellElement>('dbgRefC')
const dbgInitC         = el<HTMLTableCellElement>('dbgInitC')
const dbgFinalC        = el<HTMLTableCellElement>('dbgFinalC')
const dbgInitLoss      = el<HTMLTableCellElement>('dbgInitLoss')
const dbgFinalLoss     = el<HTMLTableCellElement>('dbgFinalLoss')
const dbgSatBefore     = el<HTMLTableCellElement>('dbgSatBefore')
const dbgSatAfter      = el<HTMLTableCellElement>('dbgSatAfter')
const dbgRefA          = el<HTMLTableCellElement>('dbgRefA')
const dbgInitA         = el<HTMLTableCellElement>('dbgInitA')
const dbgFinalA        = el<HTMLTableCellElement>('dbgFinalA')
const dbgRefBok        = el<HTMLTableCellElement>('dbgRefBok')
const dbgInitBok       = el<HTMLTableCellElement>('dbgInitBok')
const dbgFinalBok      = el<HTMLTableCellElement>('dbgFinalBok')
const dbgRedGainBefore   = el<HTMLTableCellElement>('dbgRedGainBefore')
const dbgRedGainAfter    = el<HTMLTableCellElement>('dbgRedGainAfter')
const dbgGreenGainBefore = el<HTMLTableCellElement>('dbgGreenGainBefore')
const dbgGreenGainAfter  = el<HTMLTableCellElement>('dbgGreenGainAfter')
const dbgBlueGainBefore  = el<HTMLTableCellElement>('dbgBlueGainBefore')
const dbgBlueGainAfter   = el<HTMLTableCellElement>('dbgBlueGainAfter')
const dbgLossHistory   = el<HTMLSpanElement>('dbgLossHistory')

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

// ── Palette helpers ───────────────────────────────────────────────────────

function populateCalibrationSelect(groupId: string) {
  calibrationSelect.innerHTML = ''
  for (const v of getPaletteGroup(groupId).variants) {
    const opt = document.createElement('option')
    opt.value = v.id
    opt.textContent = v.name
    calibrationSelect.appendChild(opt)
  }
  calibrationSelect.value = calibrationVariantId
}

function renderSwatches() {
  paletteSwatches.innerHTML = ''
  const palette = getPaletteVariant(paletteGroupId, calibrationVariantId)
  for (const c of palette.colors) {
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    swatch.title = c.name

    const top = document.createElement('span')
    top.className = 'swatch-measured'
    const [mr, mg, mb] = c.measured
    top.style.backgroundColor = `rgb(${mr},${mg},${mb})`

    const bot = document.createElement('span')
    bot.className = 'swatch-ideal'
    const [ir, ig, ib] = c.ideal
    bot.style.backgroundColor = `rgb(${ir},${ig},${ib})`

    swatch.appendChild(top)
    swatch.appendChild(bot)
    paletteSwatches.appendChild(swatch)
  }
}

// ── Populate selects ──────────────────────────────────────────────────────

function populateSelects() {
  // Hidden select — flat options for value/change-handler compatibility
  for (const p of DISPLAY_PRESETS) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.name
    presetSelect.appendChild(opt)
  }

  // Palette types (for Custom preset)
  for (const g of getAllPaletteGroups()) {
    const opt = document.createElement('option')
    opt.value = g.id
    opt.textContent = g.name
    paletteSelect.appendChild(opt)
  }
  paletteSelect.value = paletteGroupId

  populateCalibrationSelect(paletteGroupId)

  // Algorithms
  for (const a of getAllAlgorithms()) {
    if (a.id === 'bayer4' || a.id === 'bayer8') continue
    const opt = document.createElement('option')
    opt.value = a.id
    opt.textContent = a.name
    algorithmSelect.appendChild(opt)
  }
  algorithmSelect.value = settings.ditherAlgorithm
}

// ── Cascade device select ─────────────────────────────────────────────────

const cascadeMenu = document.createElement('div')
cascadeMenu.className = 'cascade-menu'
cascadeMenu.hidden = true
document.body.appendChild(cascadeMenu)

let activeSubmenu: HTMLElement | null = null
let hideSubTimer: ReturnType<typeof setTimeout> | null = null

function showSub(item: HTMLElement, sub: HTMLElement) {
  if (hideSubTimer) { clearTimeout(hideSubTimer); hideSubTimer = null }
  if (activeSubmenu && activeSubmenu !== sub) activeSubmenu.hidden = true
  const rect = item.getBoundingClientRect()
  sub.style.top  = `${rect.top}px`
  sub.style.left = `${rect.right + 3}px`
  sub.hidden = false
  activeSubmenu = sub
}

function scheduleSub() {
  hideSubTimer = setTimeout(() => {
    if (activeSubmenu) activeSubmenu.hidden = true
    activeSubmenu = null
    hideSubTimer = null
  }, 80)
}

function closeCascade() {
  if (hideSubTimer) { clearTimeout(hideSubTimer); hideSubTimer = null }
  if (activeSubmenu) { activeSubmenu.hidden = true; activeSubmenu = null }
  cascadeMenu.hidden = true
}

function updatePresetLabel() {
  const preset = DISPLAY_PRESETS.find(p => p.id === presetSelect.value)
  if (preset) presetLabel.textContent = preset.manufacturer
    ? `${preset.manufacturer} — ${preset.name}`
    : preset.name
}

function buildCascadeMenu() {
  const groups = new Map<string, typeof DISPLAY_PRESETS>()
  for (const p of DISPLAY_PRESETS) {
    const key = p.manufacturer || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(p)
  }

  for (const [manufacturer, presets] of groups) {
    const item = document.createElement('div')
    item.className = 'cascade-item'

    if (!manufacturer) {
      item.textContent = 'Custom'
      item.addEventListener('click', e => { e.stopPropagation(); applyPreset('custom') })
    } else {
      const nameEl = document.createElement('span')
      nameEl.textContent = manufacturer
      const arrowEl = document.createElement('span')
      arrowEl.className = 'cascade-arrow'
      arrowEl.textContent = '›'
      item.append(nameEl, arrowEl)

      const sub = document.createElement('div')
      sub.className = 'cascade-submenu'
      sub.hidden = true
      document.body.appendChild(sub)

      for (const p of presets) {
        const opt = document.createElement('div')
        opt.className = 'cascade-option'
        opt.textContent = p.name
        opt.dataset.id = p.id
        opt.addEventListener('click', e => { e.stopPropagation(); applyPreset(p.id) })
        sub.appendChild(opt)
      }

      item.addEventListener('mouseenter', () => showSub(item, sub))
      item.addEventListener('mouseleave', () => scheduleSub())
      sub.addEventListener('mouseenter', () => { if (hideSubTimer) { clearTimeout(hideSubTimer); hideSubTimer = null } })
      sub.addEventListener('mouseleave', () => scheduleSub())
    }
    cascadeMenu.appendChild(item)
  }
}

function applyPreset(id: string) {
  presetSelect.value = id
  presetSelect.dispatchEvent(new Event('change'))
  closeCascade()
}

presetTrigger.addEventListener('click', e => {
  e.stopPropagation()
  if (!cascadeMenu.hidden) { closeCascade(); return }
  const rect = presetTrigger.getBoundingClientRect()
  cascadeMenu.style.top      = `${rect.bottom + 3}px`
  cascadeMenu.style.left     = `${rect.left}px`
  cascadeMenu.style.minWidth = `${rect.width}px`
  document.querySelectorAll<HTMLElement>('.cascade-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.id === presetSelect.value)
  })
  cascadeMenu.hidden = false
})

document.addEventListener('click', () => closeCascade())

// ── Upload ─────────────────────────────────────────────────────────────────

dropZone.addEventListener('click', () => fileInput.click())
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click() })

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over') })
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))

document.addEventListener('dragover', e => { e.preventDefault() })
document.addEventListener('dragleave', e => {
  if (e.relatedTarget === null) dropZone.classList.remove('drag-over')
})
document.addEventListener('drop', e => {
  e.preventDefault()
  dropZone.classList.remove('drag-over')
  if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files)
})

fileInput.addEventListener('change', () => {
  if (fileInput.files) loadFiles(fileInput.files)
  fileInput.value = ''
})

async function loadFiles(fileList: FileList) {
  for (const file of Array.from(fileList)) {
    if (!file.type.startsWith('image/')) continue
    const id = crypto.randomUUID()
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const original = ctx.getImageData(0, 0, bitmap.width, bitmap.height)

    const img: ImageFile = {
      id,
      name: file.name,
      original,
      dithered: null,
      width: bitmap.width,
      height: bitmap.height,
    }
    images.push(img)
    addThumbnail(img, bitmap)
    bitmap.close()
  }
  if (images.length > 0) activateImage(images[images.length - 1].id)
  updateExportButtons()
}

function addThumbnail(img: ImageFile, bitmap: ImageBitmap) {
  const thumb = document.createElement('img')
  thumb.className = 'thumb'
  thumb.alt = img.name

  // Draw thumbnail
  const tc = document.createElement('canvas')
  const SIZE = 52
  tc.width = SIZE; tc.height = SIZE
  const tctx = tc.getContext('2d')!
  const ratio = bitmap.width / bitmap.height
  let tw = SIZE, th = SIZE
  if (ratio > 1) { th = SIZE / ratio } else { tw = SIZE * ratio }
  tctx.drawImage(bitmap, (SIZE - tw) / 2, (SIZE - th) / 2, tw, th)
  thumb.src = tc.toDataURL()

  thumb.dataset.id = img.id
  thumb.addEventListener('click', () => activateImage(img.id))
  thumbnailStrip.appendChild(thumb)
}

function activateImage(id: string) {
  activeId = id
  thumbnailStrip.querySelectorAll('.thumb').forEach(t => {
    ;(t as HTMLElement).classList.toggle('active', (t as HTMLElement).dataset.id === id)
  })
  const img = images.find(i => i.id === id)!

  autoOrientDisplay(img.original.width, img.original.height)

  showOriginal(img.original)

  if (img.dithered) {
    showDithered(img.dithered)
  } else {
    scheduleProcess()
  }

  emptyState.hidden = true
  previewPanels.hidden = false
  debugAutoExpose.hidden = true
  debugColorTune.hidden = true
  debugHueTune.hidden = true
}

function checkRotationConflict() {
  const preset = DISPLAY_PRESETS.find(p => p.id === presetSelect.value)
  if (!preset || preset.id === 'custom') { rotationWarn.hidden = true; return }
  const deg = parseInt(bleRotation.value)
  const outW = (deg === 90 || deg === 270) ? displayHeight : displayWidth
  const outH = (deg === 90 || deg === 270) ? displayWidth  : displayHeight
  if (outW === preset.width && outH === preset.height) {
    rotationWarn.hidden = true
  } else {
    rotationWarn.textContent = `Rotation outputs ${outW}×${outH} px but device expects ${preset.width}×${preset.height}`
    rotationWarn.hidden = false
  }
}

function autoOrientDisplay(imgW: number, imgH: number) {
  const imgPortrait  = imgH > imgW
  const dispPortrait = displayHeight > displayWidth
  if (imgPortrait !== dispPortrait) {
    ;[displayWidth, displayHeight] = [displayHeight, displayWidth]
    bleRotation.value = '270'
    invalidateAll()
  }
  checkRotationConflict()
}

function rotatePixels(
  pixels: Uint8ClampedArray, width: number, height: number, degrees: number
): { data: Uint8ClampedArray; width: number; height: number } {
  if (degrees === 0) return { data: pixels, width, height }
  const out = new Uint8ClampedArray(pixels.length)
  if (degrees === 180) {
    const total = width * height
    for (let i = 0; i < total; i++) {
      const src = (total - 1 - i) * 4
      const dst = i * 4
      out[dst] = pixels[src]; out[dst+1] = pixels[src+1]; out[dst+2] = pixels[src+2]; out[dst+3] = pixels[src+3]
    }
    return { data: out, width, height }
  }
  // 90° or 270° CW: output dims are swapped
  for (let oy = 0; oy < width; oy++) {
    for (let ox = 0; ox < height; ox++) {
      const srcIdx = degrees === 90
        ? ((height - 1 - ox) * width + oy) * 4
        : (ox * width + (width - 1 - oy)) * 4
      const dstIdx = (oy * height + ox) * 4
      out[dstIdx] = pixels[srcIdx]; out[dstIdx+1] = pixels[srcIdx+1]
      out[dstIdx+2] = pixels[srcIdx+2]; out[dstIdx+3] = pixels[srcIdx+3]
    }
  }
  return { data: out, width: height, height: width }
}

// ── Canvas rendering ───────────────────────────────────────────────────────

function putImageData(canvas: HTMLCanvasElement, data: ImageData) {
  canvas.width = data.width
  canvas.height = data.height
  canvas.getContext('2d')!.putImageData(data, 0, 0)
}

function showOriginal(data: ImageData) {
  putImageData(canvasOrig, data)
}

function showDithered(data: ImageData) {
  putImageData(canvasDith, data)
  procOverlay.hidden = true
  if (zoomed) {
    ;[panX, panY] = clampPan(panX, panY)
    applyPan()
  }
}

function refreshDitheredView() {
  const img = images.find(i => i.id === activeId)
  if (!img) return
  const data = showIdealPreview ? img.ideal : img.dithered
  if (data) showDithered(data)
  ditheredPanelLabel.textContent = showIdealPreview ? 'Export file' : 'As on device'
}

// ── Processing ─────────────────────────────────────────────────────────────

function scheduleProcess() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(processActive, 120)
}

async function processActive() {
  if (!activeId) return
  const img = images.find(i => i.id === activeId)
  if (!img) return

  procOverlay.hidden = false

  // Double-rAF: first rAF exits, browser paints overlay visible, second rAF fires before pipeline runs
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

  const palette = getPaletteVariant(paletteGroupId, calibrationVariantId)
  const srcBitmap = await createImageBitmap(img.original)

  const result = runPipeline({
    source: srcBitmap,
    srcWidth: img.original.width,
    srcHeight: img.original.height,
    dstWidth: displayWidth,
    dstHeight: displayHeight,
    resizeMode,
    palette,
    settings,
  })
  srcBitmap.close()

  // Update original preview to show the resized version (so both panels match dimensions)
  const resized = resizeForPreview(img.original, displayWidth, displayHeight, resizeMode)
  putImageData(canvasOrig, resized)

  img.dithered = result.measured
  img.ideal = result.ideal
  img.width = displayWidth
  img.height = displayHeight

  refreshDitheredView()
  updatePaletteBadge()
  renderSwatches()
  updateExportButtons()
}

function resizeForPreview(src: ImageData, dw: number, dh: number, mode: ResizeMode): ImageData {
  const bmp = imageDataToBitmap(src)
  // Use a synchronous canvas draw
  const c = document.createElement('canvas')
  c.width = dw; c.height = dh
  const ctx = c.getContext('2d')!

  const sw = src.width, sh = src.height
  const sr = sw / sh, dr = dw / dh

  if (mode === 'stretch') {
    ctx.drawImage(bmp as unknown as CanvasImageSource, 0, 0, dw, dh)
  } else if (mode === 'none') {
    const dx = Math.round((dw - sw) / 2), dy = Math.round((dh - sh) / 2)
    ctx.drawImage(bmp as unknown as CanvasImageSource, dx, dy)
  } else if (mode === 'cover') {
    let tw: number, th: number
    if (sr > dr) { th = dh; tw = th * sr } else { tw = dw; th = tw / sr }
    const ox = (dw - tw) / 2, oy = (dh - th) / 2
    ctx.drawImage(bmp as unknown as CanvasImageSource, ox, oy, tw, th)
  } else {
    let tw: number, th: number
    if (sr > dr) { tw = dw; th = tw / sr } else { th = dh; tw = th * sr }
    const ox = (dw - tw) / 2, oy = (dh - th) / 2
    ctx.fillStyle = '#d5d3cc'; ctx.fillRect(0, 0, dw, dh)
    ctx.drawImage(bmp as unknown as CanvasImageSource, ox, oy, tw, th)
  }
  return ctx.getImageData(0, 0, dw, dh)
}

function imageDataToBitmap(data: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = data.width; c.height = data.height
  c.getContext('2d')!.putImageData(data, 0, 0)
  return c
}

// ── UI wiring ─────────────────────────────────────────────────────────────

// Display preset
function setDimsEditable(editable: boolean) {
  dimWidth.readOnly = !editable
  dimHeight.readOnly = !editable
  paletteSelect.disabled = !editable
  customDims.classList.toggle('dims-readonly', !editable)
}

presetSelect.addEventListener('change', () => {
  updatePresetLabel()
  const preset = DISPLAY_PRESETS.find(p => p.id === presetSelect.value)!
  if (preset.id === 'custom') {
    setDimsEditable(true)
  } else {
    setDimsEditable(false)
    displayWidth = preset.width
    displayHeight = preset.height
    paletteGroupId = preset.paletteGroupId
    paletteSelect.value = paletteGroupId
    const group = getPaletteGroup(paletteGroupId)
    calibrationVariantId = group.variants[0].id
    populateCalibrationSelect(paletteGroupId)
    renderSwatches()
    dimWidth.value = String(preset.width)
    dimHeight.value = String(preset.height)
    // Re-apply orientation for the currently active image
    const activeImg = images.find(i => i.id === activeId)
    if (activeImg) autoOrientDisplay(activeImg.original.width, activeImg.original.height)
    else checkRotationConflict()
  }
  invalidateAll()
  scheduleProcess()
})

bleRotation.addEventListener('change', () => checkRotationConflict())

dimWidth.addEventListener('input', () => {
  displayWidth = parseInt(dimWidth.value) || 800
  checkRotationConflict()
  invalidateAll(); scheduleProcess()
})
dimHeight.addEventListener('input', () => {
  displayHeight = parseInt(dimHeight.value) || 480
  checkRotationConflict()
  invalidateAll(); scheduleProcess()
})
paletteSelect.addEventListener('change', () => {
  paletteGroupId = paletteSelect.value
  const group = getPaletteGroup(paletteGroupId)
  calibrationVariantId = group.variants[0].id
  populateCalibrationSelect(paletteGroupId)
  renderSwatches()
  invalidateAll(); scheduleProcess()
})

calibrationSelect.addEventListener('change', () => {
  calibrationVariantId = calibrationSelect.value
  renderSwatches()
  invalidateAll(); scheduleProcess()
})

resizeModeSelect.addEventListener('change', () => {
  resizeMode = resizeModeSelect.value as ResizeMode
  invalidateAll(); scheduleProcess()
})

// Tone preset buttons
el<HTMLDivElement>('tonePresets').addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest('.preset-btn') as HTMLButtonElement | null
  if (!btn) return
  const name = btn.dataset.preset as PresetName
  if (name === 'custom') return // selecting custom is handled by slider changes
  setPreset(name)
})

function setPreset(name: Exclude<PresetName, 'custom'>) {
  activePreset = name
  settings = { ...PRESETS[name] }
  syncSlidersFromSettings()
  document.querySelectorAll('.preset-btn').forEach(b =>
    b.classList.toggle('active', (b as HTMLElement).dataset.preset === name)
  )
  invalidateAll(); scheduleProcess()
}

function settingsMatchPreset(s: ProcessingSettings, preset: ProcessingSettings): boolean {
  return (Object.keys(preset) as (keyof ProcessingSettings)[]).every(key => {
    const a = s[key], b = preset[key]
    return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b
  })
}

function markCustomPreset() {
  const effectiveName = settingsMatchPreset(settings, PRESETS[activePreset]) ? activePreset : 'custom'
  document.querySelectorAll('.preset-btn').forEach(b =>
    b.classList.toggle('active', (b as HTMLElement).dataset.preset === effectiveName)
  )
}

function getResetDefaults(): ProcessingSettings {
  return PRESETS[activePreset]
}

// Sliders
function makeValEditable(
  valEl: HTMLSpanElement,
  min: number,
  max: number,
  decimals: number,
  onCommit: (v: number) => void,
  format?: (v: number) => string,
) {
  let savedText = ''
  let escaping = false

  valEl.addEventListener('click', () => {
    if (valEl.contentEditable === 'true') return
    savedText = valEl.textContent ?? ''
    valEl.contentEditable = 'true'
    valEl.focus()
    const range = document.createRange()
    range.selectNodeContents(valEl)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  })

  valEl.addEventListener('blur', () => {
    if (escaping) { escaping = false; return }
    valEl.contentEditable = 'false'
    const parsed = parseFloat(valEl.textContent ?? '')
    if (isFinite(parsed)) {
      const clamped = Math.max(min, Math.min(max, parsed))
      onCommit(clamped)
      valEl.textContent = format ? format(clamped) : clamped.toFixed(decimals)
    } else {
      valEl.textContent = savedText
    }
  })

  valEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); valEl.blur() }
    if (e.key === 'Escape') {
      escaping = true
      valEl.contentEditable = 'false'
      valEl.textContent = savedText
      valEl.blur()
    }
  })
}

function sliderSetup(
  sliderId: string,
  valId: string,
  scale: number,
  key: keyof ProcessingSettings,
  decimals = 2,
) {
  const slider = el<HTMLInputElement>(sliderId)
  const valEl = el<HTMLSpanElement>(valId)

  slider.addEventListener('input', () => {
    const v = parseInt(slider.value) / scale
    ;(settings as unknown as Record<string, number>)[key as string] = v
    valEl.textContent = v.toFixed(decimals)
    markCustomPreset()
    invalidateAll(); scheduleProcess()
  })

  slider.addEventListener('dblclick', () => {
    const defaultVal = (getResetDefaults() as unknown as Record<string, number>)[key as string]
    slider.value = String(Math.round(defaultVal * scale))
    ;(settings as unknown as Record<string, number>)[key as string] = defaultVal
    valEl.textContent = defaultVal.toFixed(decimals)
    markCustomPreset(); invalidateAll(); scheduleProcess()
  })

  makeValEditable(
    valEl,
    parseInt(slider.min) / scale,
    parseInt(slider.max) / scale,
    decimals,
    v => {
      ;(settings as unknown as Record<string, number>)[key as string] = v
      slider.value = String(Math.round(v * scale))
      markCustomPreset(); invalidateAll(); scheduleProcess()
    },
  )
}

sliderSetup('sliderExposure', 'valExposure', 100, 'exposure')
sliderSetup('sliderSaturation', 'valSaturation', 100, 'saturation')
sliderSetup('sliderClarity', 'valClarity', 100, 'clarity', 2)
sliderSetup('sliderClarityRadius', 'valClarityRadius', 1, 'clarityRadius', 0)
sliderSetup('sliderRedGain',   'valRedGain',   100, 'redGain')
sliderSetup('sliderGreenGain', 'valGreenGain', 100, 'greenGain')
sliderSetup('sliderBlueGain',  'valBlueGain',  100, 'blueGain')

const HUE_BAND_NAMES = ['Red', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta'] as const
HUE_BAND_NAMES.forEach((name, idx) => {
  const slider = el<HTMLInputElement>(`sliderHueSat${name}`)
  const valEl  = el<HTMLSpanElement>(`valHueSat${name}`)
  slider.addEventListener('input', () => {
    const v = parseInt(slider.value) / 100
    settings.hueSatBands[idx] = v
    valEl.textContent = v.toFixed(2)
    markCustomPreset(); invalidateAll(); scheduleProcess()
  })
  slider.addEventListener('dblclick', () => {
    settings.hueSatBands[idx] = 1
    slider.value = '100'
    valEl.textContent = '1.00'
    markCustomPreset(); invalidateAll(); scheduleProcess()
  })
  makeValEditable(valEl, 0.25, 4.0, 2, v => {
    settings.hueSatBands[idx] = v
    slider.value = String(Math.round(v * 100))
    markCustomPreset(); invalidateAll(); scheduleProcess()
  })
})
sliderSetup('sliderContrast', 'valContrast', 100, 'contrast')
sliderSetup('sliderStrength', 'valStrength', 100, 'strength')
sliderSetup('sliderShadowBoost', 'valShadowBoost', 100, 'shadowBoost')
sliderSetup('sliderHighlightCompress', 'valHighlightCompress', 100, 'highlightCompress')
sliderSetup('sliderMidpoint', 'valMidpoint', 100, 'midpoint')
el<HTMLInputElement>('sliderDitherStrength').addEventListener('input', () => {
  const pct = parseInt(el<HTMLInputElement>('sliderDitherStrength').value)
  settings.ditherStrength = pct / 100
  el<HTMLSpanElement>('valDitherStrength').textContent = String(pct) + '%'
  markCustomPreset(); invalidateAll(); scheduleProcess()
});
el<HTMLInputElement>('sliderDitherStrength').addEventListener('dblclick', () => {
  const v = getResetDefaults().ditherStrength
  el<HTMLInputElement>('sliderDitherStrength').value = String(Math.round(v * 100))
  settings.ditherStrength = v
  el<HTMLSpanElement>('valDitherStrength').textContent = String(Math.round(v * 100)) + '%'
  markCustomPreset(); invalidateAll(); scheduleProcess()
})
makeValEditable(el<HTMLSpanElement>('valDitherStrength'), 0, 100, 0, v => {
  el<HTMLInputElement>('sliderDitherStrength').value = String(Math.round(v))
  settings.ditherStrength = v / 100
  markCustomPreset(); invalidateAll(); scheduleProcess()
}, v => String(Math.round(v)) + '%')

el<HTMLInputElement>('sliderKnoxAlpha').addEventListener('input', () => {
  const pct = parseInt(el<HTMLInputElement>('sliderKnoxAlpha').value)
  settings.knoxAlpha = pct / 100
  el<HTMLSpanElement>('valKnoxAlpha').textContent = (pct / 100).toFixed(2)
  markCustomPreset(); invalidateAll(); scheduleProcess()
});
el<HTMLInputElement>('sliderKnoxAlpha').addEventListener('dblclick', () => {
  const v = getResetDefaults().knoxAlpha
  el<HTMLInputElement>('sliderKnoxAlpha').value = String(Math.round(v * 100))
  settings.knoxAlpha = v
  el<HTMLSpanElement>('valKnoxAlpha').textContent = v.toFixed(2)
  markCustomPreset(); invalidateAll(); scheduleProcess()
})
makeValEditable(el<HTMLSpanElement>('valKnoxAlpha'), 0, 1, 2, v => {
  el<HTMLInputElement>('sliderKnoxAlpha').value = String(Math.round(v * 100))
  settings.knoxAlpha = v
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

el<HTMLInputElement>('sliderKnoxFringe').addEventListener('input', () => {
  const v = parseInt(el<HTMLInputElement>('sliderKnoxFringe').value)
  settings.knoxFringe = v / 100
  el<HTMLSpanElement>('valKnoxFringe').textContent = (v / 100).toFixed(2)
  markCustomPreset(); invalidateAll(); scheduleProcess()
});
el<HTMLInputElement>('sliderKnoxFringe').addEventListener('dblclick', () => {
  const v = getResetDefaults().knoxFringe
  el<HTMLInputElement>('sliderKnoxFringe').value = String(Math.round(v * 100))
  settings.knoxFringe = v
  el<HTMLSpanElement>('valKnoxFringe').textContent = v.toFixed(2)
  markCustomPreset(); invalidateAll(); scheduleProcess()
})
makeValEditable(el<HTMLSpanElement>('valKnoxFringe'), 0, 0.15, 2, v => {
  el<HTMLInputElement>('sliderKnoxFringe').value = String(Math.round(v * 100))
  settings.knoxFringe = v
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

el<HTMLInputElement>('sliderKnoxEdge').addEventListener('input', () => {
  const v = parseInt(el<HTMLInputElement>('sliderKnoxEdge').value)
  settings.knoxEdgeSensitivity = v / 100
  el<HTMLSpanElement>('valKnoxEdge').textContent = (v / 100).toFixed(1)
  markCustomPreset(); invalidateAll(); scheduleProcess()
});
el<HTMLInputElement>('sliderKnoxEdge').addEventListener('dblclick', () => {
  const v = getResetDefaults().knoxEdgeSensitivity
  el<HTMLInputElement>('sliderKnoxEdge').value = String(Math.round(v * 100))
  settings.knoxEdgeSensitivity = v
  el<HTMLSpanElement>('valKnoxEdge').textContent = v.toFixed(1)
  markCustomPreset(); invalidateAll(); scheduleProcess()
})
makeValEditable(el<HTMLSpanElement>('valKnoxEdge'), 0.5, 8, 1, v => {
  el<HTMLInputElement>('sliderKnoxEdge').value = String(Math.round(v * 100))
  settings.knoxEdgeSensitivity = v
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

el<HTMLInputElement>('sliderRiemersmaQueue').addEventListener('input', () => {
  const v = parseInt(el<HTMLInputElement>('sliderRiemersmaQueue').value)
  settings.riemersmaQueueSize = v
  el<HTMLSpanElement>('valRiemersmaQueue').textContent = String(v)
  markCustomPreset(); invalidateAll(); scheduleProcess()
});
el<HTMLInputElement>('sliderRiemersmaQueue').addEventListener('dblclick', () => {
  const v = getResetDefaults().riemersmaQueueSize
  el<HTMLInputElement>('sliderRiemersmaQueue').value = String(v)
  settings.riemersmaQueueSize = v
  el<HTMLSpanElement>('valRiemersmaQueue').textContent = String(v)
  markCustomPreset(); invalidateAll(); scheduleProcess()
})
makeValEditable(el<HTMLSpanElement>('valRiemersmaQueue'), 4, 64, 0, v => {
  const snapped = Math.round(v / 4) * 4
  el<HTMLInputElement>('sliderRiemersmaQueue').value = String(snapped)
  settings.riemersmaQueueSize = snapped
  markCustomPreset(); invalidateAll(); scheduleProcess()
}, v => String(Math.round(v / 4) * 4))

el<HTMLInputElement>('sliderDizzyDiagonal').addEventListener('input', () => {
  const v = parseInt(el<HTMLInputElement>('sliderDizzyDiagonal').value)
  settings.dizzyDiagonalWeight = v / 100
  el<HTMLSpanElement>('valDizzyDiagonal').textContent = (v / 100).toFixed(2)
  markCustomPreset(); invalidateAll(); scheduleProcess()
});
el<HTMLInputElement>('sliderDizzyDiagonal').addEventListener('dblclick', () => {
  const v = getResetDefaults().dizzyDiagonalWeight
  el<HTMLInputElement>('sliderDizzyDiagonal').value = String(Math.round(v * 100))
  settings.dizzyDiagonalWeight = v
  el<HTMLSpanElement>('valDizzyDiagonal').textContent = v.toFixed(2)
  markCustomPreset(); invalidateAll(); scheduleProcess()
})
makeValEditable(el<HTMLSpanElement>('valDizzyDiagonal'), 0, 1, 2, v => {
  el<HTMLInputElement>('sliderDizzyDiagonal').value = String(Math.round(v * 100))
  settings.dizzyDiagonalWeight = v
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

checkCDR.addEventListener('change', () => {
  settings.compressDynamicRange = checkCDR.checked
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

btnAutoTune.addEventListener('click', async () => {
  if (!activeId) return
  const img = images.find(i => i.id === activeId)
  if (!img) return

  btnAutoTune.disabled = true
  btnAutoTune.textContent = 'Exposing…'
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

  const palette = getPaletteVariant(paletteGroupId, calibrationVariantId)
  const srcBitmap = await createImageBitmap(img.original)

  // Step 1: Auto Expose
  const exposeResult = autoExpose({
    source: srcBitmap,
    srcWidth: img.original.width,
    srcHeight: img.original.height,
    dstWidth: displayWidth,
    dstHeight: displayHeight,
    resizeMode,
    palette,
    settings,
  })
  settings.exposure          = exposeResult.exposure
  settings.saturation        = exposeResult.saturation
  settings.contrast          = exposeResult.contrast
  settings.strength          = exposeResult.strength
  settings.shadowBoost       = exposeResult.shadowBoost
  settings.highlightCompress = exposeResult.highlightCompress
  settings.midpoint          = exposeResult.midpoint
  settings.redGain           = exposeResult.redGain
  settings.greenGain         = exposeResult.greenGain
  settings.blueGain          = exposeResult.blueGain
  settings.compressDynamicRange = exposeResult.compressDynamicRange

  // Step 2: Color-tune
  btnAutoTune.textContent = 'Color-tuning…'
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

  const tuneResult = colorTune({
    source: srcBitmap,
    srcWidth: img.original.width,
    srcHeight: img.original.height,
    dstWidth: displayWidth,
    dstHeight: displayHeight,
    resizeMode,
    palette,
    settings,
  })
  settings.saturation = tuneResult.saturation
  settings.redGain    = tuneResult.redGain
  settings.greenGain  = tuneResult.greenGain
  settings.blueGain   = tuneResult.blueGain

  // Step 3: Hue-tune
  btnAutoTune.textContent = 'Hue-tuning…'
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

  const hueResult = hueTune({
    source: srcBitmap,
    srcWidth: img.original.width,
    srcHeight: img.original.height,
    dstWidth: displayWidth,
    dstHeight: displayHeight,
    resizeMode,
    palette,
    settings,
  })
  srcBitmap.close()

  settings.hueSatBands = hueResult.hueSatBands

  markCustomPreset()
  syncSlidersFromSettings()
  invalidateAll()
  scheduleProcess()
  showAutoExposeDebug(exposeResult.debug)
  showColorTuneDebug(tuneResult.debug)
  showHueTuneDebug(hueResult.debug)

  btnAutoTune.disabled = false
  btnAutoTune.textContent = 'Auto-tune'
})

btnColorTune.addEventListener('click', async () => {
  if (!activeId) return
  const img = images.find(i => i.id === activeId)
  if (!img) return

  btnColorTune.disabled = true
  btnColorTune.textContent = 'Tuning…'
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

  const palette = getPaletteVariant(paletteGroupId, calibrationVariantId)
  const srcBitmap = await createImageBitmap(img.original)
  const result = colorTune({
    source: srcBitmap,
    srcWidth: img.original.width,
    srcHeight: img.original.height,
    dstWidth: displayWidth,
    dstHeight: displayHeight,
    resizeMode,
    palette,
    settings,
  })
  srcBitmap.close()

  settings.saturation = result.saturation
  settings.redGain    = result.redGain
  settings.greenGain  = result.greenGain
  settings.blueGain   = result.blueGain
  markCustomPreset()
  syncSlidersFromSettings()
  invalidateAll()
  scheduleProcess()
  showColorTuneDebug(result.debug)

  btnColorTune.disabled = false
  btnColorTune.textContent = 'Color-tune'
})

btnHueTune.addEventListener('click', async () => {
  if (!activeId) return
  const img = images.find(i => i.id === activeId)
  if (!img) return

  btnHueTune.disabled = true
  btnHueTune.textContent = 'Tuning…'
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

  const palette = getPaletteVariant(paletteGroupId, calibrationVariantId)
  const srcBitmap = await createImageBitmap(img.original)
  const result = hueTune({
    source: srcBitmap,
    srcWidth: img.original.width,
    srcHeight: img.original.height,
    dstWidth: displayWidth,
    dstHeight: displayHeight,
    resizeMode,
    palette,
    settings,
  })
  srcBitmap.close()

  settings.hueSatBands = result.hueSatBands
  markCustomPreset()
  syncSlidersFromSettings()
  invalidateAll()
  scheduleProcess()
  showHueTuneDebug(result.debug)

  btnHueTune.disabled = false
  btnHueTune.textContent = 'Hue-tune'
})

btnAutoExpose.addEventListener('click', async () => {
  if (!activeId) return
  const img = images.find(i => i.id === activeId)
  if (!img) return

  btnAutoExpose.disabled = true
  btnAutoExpose.textContent = 'Exposing…'
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

  const palette = getPaletteVariant(paletteGroupId, calibrationVariantId)
  const srcBitmap = await createImageBitmap(img.original)
  const result = autoExpose({
    source: srcBitmap,
    srcWidth: img.original.width,
    srcHeight: img.original.height,
    dstWidth: displayWidth,
    dstHeight: displayHeight,
    resizeMode,
    palette,
    settings,
  })
  srcBitmap.close()

  settings.exposure          = result.exposure
  settings.saturation        = result.saturation
  settings.contrast          = result.contrast
  settings.strength          = result.strength
  settings.shadowBoost       = result.shadowBoost
  settings.highlightCompress = result.highlightCompress
  settings.midpoint          = result.midpoint
  settings.redGain           = result.redGain
  settings.greenGain         = result.greenGain
  settings.blueGain          = result.blueGain
  settings.compressDynamicRange = result.compressDynamicRange

  markCustomPreset()
  syncSlidersFromSettings()
  invalidateAll()
  scheduleProcess()
  showAutoExposeDebug(result.debug)

  btnAutoExpose.disabled = false
  btnAutoExpose.textContent = 'Auto Expose'
})

toneModeSelect.addEventListener('change', () => {
  settings.toneMode = toneModeSelect.value as 'contrast' | 'scurve'
  panelContrast.hidden = settings.toneMode !== 'contrast'
  panelScurve.hidden = settings.toneMode !== 'scurve'
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

algorithmSelect.addEventListener('change', () => {
  settings.ditherAlgorithm = algorithmSelect.value
  const isKnox       = settings.ditherAlgorithm === 'knox'
  const isRiemersma  = settings.ditherAlgorithm === 'riemersma'
  const isDizzy      = settings.ditherAlgorithm === 'dizzy'
  panelKnoxAlpha.hidden      = !isKnox
  panelRiemersmaQueue.hidden = !isRiemersma
  panelDizzyDiagonal.hidden  = !isDizzy
  panelSerpentine.hidden     = !SERPENTINE_ALGORITHMS.has(settings.ditherAlgorithm)
  panelColorMatching.hidden  = isKnox
  panelLocalVariance.hidden  = isKnox
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

function applyColorPreset(value: string) {
  const sep = value.indexOf('_')
  const errSpace  = value.slice(0, sep)       as import('./types').ColorSpace
  const distSpace = value.slice(sep + 1)      as import('./types').ColorSpace
  settings.errorSpace = errSpace
  settings.distSpace  = distSpace
  errorSpaceSel.textContent = colorSpaceLabel[errSpace]
  distSpaceSel.textContent  = colorSpaceLabel[distSpace]
}

colorPresetSel.addEventListener('change', () => {
  applyColorPreset(colorPresetSel.value)
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

serpentineCheck.addEventListener('change', () => {
  settings.serpentine = serpentineCheck.checked
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

localVarianceCheck.addEventListener('change', () => {
  settings.localVarianceDetection = localVarianceCheck.checked
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

expandPaletteCheck.addEventListener('change', () => {
  settings.expandPalette = expandPaletteCheck.checked
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

previewToggleBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    showIdealPreview = btn.dataset.mode === 'export'
    previewToggleBtns.forEach(b => b.classList.toggle('active', b === btn))
    refreshDitheredView()
  })
})

function syncSlidersFromSettings() {
  setSlider('sliderExposure', 'valExposure', settings.exposure * 100, settings.exposure)
  setSlider('sliderSaturation', 'valSaturation', settings.saturation * 100, settings.saturation)
  setSlider('sliderClarity', 'valClarity', settings.clarity * 100, settings.clarity)
  el<HTMLInputElement>('sliderClarityRadius').value = String(settings.clarityRadius)
  el<HTMLSpanElement>('valClarityRadius').textContent = String(settings.clarityRadius)
  setSlider('sliderRedGain',   'valRedGain',   settings.redGain   * 100, settings.redGain)
  setSlider('sliderGreenGain', 'valGreenGain', settings.greenGain * 100, settings.greenGain)
  setSlider('sliderBlueGain',  'valBlueGain',  settings.blueGain  * 100, settings.blueGain)
  HUE_BAND_NAMES.forEach((name, idx) => {
    setSlider(`sliderHueSat${name}`, `valHueSat${name}`, settings.hueSatBands[idx] * 100, settings.hueSatBands[idx])
  })
  setSlider('sliderContrast', 'valContrast', settings.contrast * 100, settings.contrast)
  setSlider('sliderStrength', 'valStrength', settings.strength * 100, settings.strength)
  setSlider('sliderShadowBoost', 'valShadowBoost', settings.shadowBoost * 100, settings.shadowBoost)
  setSlider('sliderHighlightCompress', 'valHighlightCompress', settings.highlightCompress * 100, settings.highlightCompress)
  setSlider('sliderMidpoint', 'valMidpoint', settings.midpoint * 100, settings.midpoint)
  checkCDR.checked = settings.compressDynamicRange
  toneModeSelect.value = settings.toneMode
  panelContrast.hidden = settings.toneMode !== 'contrast'
  panelScurve.hidden   = settings.toneMode !== 'scurve'
  algorithmSelect.value = settings.ditherAlgorithm
  const isKnox      = settings.ditherAlgorithm === 'knox'
  const isRiemersma = settings.ditherAlgorithm === 'riemersma'
  const isDizzy     = settings.ditherAlgorithm === 'dizzy'
  panelKnoxAlpha.hidden      = !isKnox
  panelRiemersmaQueue.hidden = !isRiemersma
  panelDizzyDiagonal.hidden  = !isDizzy
  panelSerpentine.hidden     = !SERPENTINE_ALGORITHMS.has(settings.ditherAlgorithm)
  panelColorMatching.hidden  = isKnox
  panelLocalVariance.hidden  = isKnox
  serpentineCheck.checked    = settings.serpentine ?? true
  const knoxPct = Math.round((settings.knoxAlpha ?? 0.5) * 100)
  el<HTMLInputElement>('sliderKnoxAlpha').value = String(knoxPct)
  el<HTMLSpanElement>('valKnoxAlpha').textContent = (knoxPct / 100).toFixed(2)
  const knoxFringePct = Math.round((settings.knoxFringe ?? 0.04) * 100)
  el<HTMLInputElement>('sliderKnoxFringe').value = String(knoxFringePct)
  el<HTMLSpanElement>('valKnoxFringe').textContent = (knoxFringePct / 100).toFixed(2)
  const knoxEdgePct = Math.round((settings.knoxEdgeSensitivity ?? 4.0) * 100)
  el<HTMLInputElement>('sliderKnoxEdge').value = String(knoxEdgePct)
  el<HTMLSpanElement>('valKnoxEdge').textContent = (knoxEdgePct / 100).toFixed(1)
  const riemQ = Math.round(settings.riemersmaQueueSize ?? 16)
  el<HTMLInputElement>('sliderRiemersmaQueue').value = String(riemQ)
  el<HTMLSpanElement>('valRiemersmaQueue').textContent = String(riemQ)
  const dizzyDiagPct = Math.round((settings.dizzyDiagonalWeight ?? 0.1) * 100)
  el<HTMLInputElement>('sliderDizzyDiagonal').value = String(dizzyDiagPct)
  el<HTMLSpanElement>('valDizzyDiagonal').textContent = (dizzyDiagPct / 100).toFixed(2)
  const pct = Math.round(settings.ditherStrength * 100)
  el<HTMLInputElement>('sliderDitherStrength').value = String(pct)
  el<HTMLSpanElement>('valDitherStrength').textContent = String(pct) + '%'
  errorSpaceSel.textContent = colorSpaceLabel[settings.errorSpace]
  distSpaceSel.textContent  = colorSpaceLabel[settings.distSpace]
  colorPresetSel.value = `${settings.errorSpace}_${settings.distSpace}`
  localVarianceCheck.checked = settings.localVarianceDetection
  expandPaletteCheck.checked = settings.expandPalette
}

function setSlider(sliderId: string, valId: string, sliderVal: number, displayVal: number) {
  el<HTMLInputElement>(sliderId).value = String(Math.round(sliderVal))
  el<HTMLSpanElement>(valId).textContent = displayVal.toFixed(2)
}

// ── Invalidation ──────────────────────────────────────────────────────────

function invalidateAll() {
  for (const img of images) img.dithered = null
  debugAutoExpose.hidden = true
  debugColorTune.hidden = true
  debugHueTune.hidden = true
}

// ── Auto-tune debug panel ─────────────────────────────────────────────────

function showAutoExposeDebug(d: AutoExposeDebug) {
  const f3 = (n: number) => n.toFixed(3)
  const pct = (n: number) => (n * 100).toFixed(1) + '%'
  const txt = (id: string, v: string) => { (document.getElementById(id) as HTMLElement).textContent = v }

  txt('dbgExpMeanL',          f3(d.meanL))
  txt('dbgExpStdL',           f3(d.stddevL))
  txt('dbgExpShadowL',        f3(d.shadowMeanL))
  txt('dbgExpHighlights',     pct(d.highlightFraction))
  txt('dbgExpExposure',       f3(settings.exposure))
  txt('dbgExpContrast',       f3(settings.contrast))
  txt('dbgExpStrength',       f3(settings.strength))
  txt('dbgExpShadowBoost',    f3(settings.shadowBoost))
  txt('dbgExpHighlightCompress', f3(settings.highlightCompress))

  const isContrast = settings.toneMode === 'contrast'
  ;(document.getElementById('dbgExpContrastRow') as HTMLElement).hidden = !isContrast
  ;(document.getElementById('dbgExpStrengthRow') as HTMLElement).hidden = isContrast
  ;(document.getElementById('dbgExpShadowRow') as HTMLElement).hidden = isContrast
  ;(document.getElementById('dbgExpHighlightRow') as HTMLElement).hidden = isContrast

  debugAutoExpose.hidden = false
}

function showColorTuneDebug(d: ColorTuneDebug) {
  const f3 = (n: number) => n.toFixed(3)
  const f2 = (n: number) => n.toFixed(2)

  const iters = d.iterationsRun
  const statusLabel = iters === 0
    ? 'no change (already optimal)'
    : `${iters} iteration${iters !== 1 ? 's' : ''} · ${d.converged ? 'converged' : 'hit limit'}`
  dbgSummary.textContent = statusLabel

  dbgRefC.textContent    = f3(d.refStats.meanC)
  dbgRefA.textContent    = f3(d.refStats.meanA)
  dbgRefBok.textContent  = f3(d.refStats.meanBv)
  dbgInitC.textContent   = f3(d.initialStats.meanC)
  dbgInitA.textContent   = f3(d.initialStats.meanA)
  dbgInitBok.textContent = f3(d.initialStats.meanBv)
  dbgFinalC.textContent  = f3(d.finalStats.meanC)
  dbgFinalA.textContent  = f3(d.finalStats.meanA)
  dbgFinalBok.textContent = f3(d.finalStats.meanBv)
  dbgInitLoss.textContent  = f3(d.initialLoss)
  dbgFinalLoss.textContent = f3(d.finalLoss)

  dbgSatBefore.textContent = f2(d.initialSaturation)
  dbgSatAfter.textContent  = f2(d.finalSaturation)

  dbgRedGainBefore.textContent   = f2(d.initialRedGain)
  dbgRedGainAfter.textContent    = f2(d.finalRedGain)
  dbgGreenGainBefore.textContent = f2(d.initialGreenGain)
  dbgGreenGainAfter.textContent  = f2(d.finalGreenGain)
  dbgBlueGainBefore.textContent  = f2(d.initialBlueGain)
  dbgBlueGainAfter.textContent   = f2(d.finalBlueGain)

  dbgLossHistory.textContent = d.lossHistory.map(f3).join(' → ')

  debugColorTune.hidden = false
}

function showHueTuneDebug(d: HueTuneDebug) {
  const f2 = (n: number) => n.toFixed(2)
  const f3 = (n: number) => n.toFixed(3)

  const iters = d.iterationsRun
  const statusLabel = iters === 0
    ? 'no change (already optimal)'
    : `${iters} iteration${iters !== 1 ? 's' : ''} · ${d.converged ? 'converged' : 'hit limit'}`
  el<HTMLSpanElement>('dbgHueSummary').textContent = statusLabel

  const bandIds = ['Red', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta'] as const
  for (const band of d.bands) {
    const name = band.name as typeof bandIds[number]
    if (band.pixelCount < 50) {
      el<HTMLTableCellElement>(`dbgHueRef${name}`).textContent       = '—'
      el<HTMLTableCellElement>(`dbgHueInit${name}`).textContent      = '—'
      el<HTMLTableCellElement>(`dbgHueFinal${name}`).textContent     = '—'
      el<HTMLTableCellElement>(`dbgHueBandInit${name}`).textContent  = '—'
      el<HTMLTableCellElement>(`dbgHueBandFinal${name}`).textContent = '—'
      el<HTMLTableCellElement>(`dbgHueCnt${name}`).textContent       = String(band.pixelCount)
    } else {
      el<HTMLTableCellElement>(`dbgHueRef${name}`).textContent       = f3(band.refMeanC)
      el<HTMLTableCellElement>(`dbgHueInit${name}`).textContent      = f3(band.initialMeanC)
      el<HTMLTableCellElement>(`dbgHueFinal${name}`).textContent     = f3(band.finalMeanC)
      el<HTMLTableCellElement>(`dbgHueBandInit${name}`).textContent  = f2(band.initialBandValue)
      el<HTMLTableCellElement>(`dbgHueBandFinal${name}`).textContent = f2(band.finalBandValue)
      el<HTMLTableCellElement>(`dbgHueCnt${name}`).textContent       = String(band.pixelCount)
    }
  }

  el<HTMLSpanElement>('dbgHueLossHistory').textContent = d.lossHistory.map(f3).join(' → ')

  debugHueTune.hidden = false
}

// ── Palette badge ─────────────────────────────────────────────────────────

function updatePaletteBadge() {
  try {
    const group   = getPaletteGroup(paletteGroupId)
    const variant = getPaletteVariant(paletteGroupId, calibrationVariantId)
    paletteBadge.textContent = `${group.name} — ${variant.name}`
  } catch {
    paletteBadge.textContent = ''
  }
}

// ── Export ────────────────────────────────────────────────────────────────

let downloadFormat: 'png' | 'bmp' = 'png'

function updateExportButtons() {
  const hasResult = images.some(i => i.dithered)
  btnDownloadMain.disabled = !hasResult
  btnDownloadArrow.disabled = !hasResult
  btnDownloadZip.disabled = !hasResult || images.length < 2
  const supported = bleProtocol === 'opendisplay'
    ? bleIsSupported(paletteGroupId)
    : giciskyIsSupported(paletteGroupId)
  const canUpload = hasResult && supported
  btnUploadDevice.disabled = !canUpload
  btnUploadDeviceArrow.disabled = !canUpload
  const protocolName = bleProtocol === 'opendisplay' ? 'OpenDisplay' : 'Gicisky'
  btnUploadDevice.title = canUpload ? '' : `This palette is not supported by ${protocolName}`
}

btnDownloadMain.addEventListener('click', async () => {
  const img = images.find(i => i.id === activeId)
  if (!img?.ideal) return
  const rotated = applyRotationToImageData(img.ideal)
  if (downloadFormat === 'bmp') {
    downloadBlob(imageDataToBmpBlob(rotated), stripExt(img.name) + '_dithered.bmp')
  } else {
    downloadBlob(await imageDataToBlob(rotated), stripExt(img.name) + '_dithered.png')
  }
})

btnDownloadArrow.addEventListener('click', (e) => {
  e.stopPropagation()
  const open = !splitDownloadMenu.hidden
  splitDownloadMenu.hidden = open
  btnDownloadArrow.setAttribute('aria-expanded', String(!open))
})

splitDownloadMenu.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.split-option')
  if (!btn) return
  downloadFormat = btn.dataset.format as 'png' | 'bmp'
  btnDownloadMain.textContent = `↓ ${downloadFormat.toUpperCase()}`
  splitDownloadMenu.querySelectorAll('.split-option').forEach(o => {
    (o as HTMLElement).dataset.active = o === btn ? '' : undefined!
    if (o !== btn) delete (o as HTMLElement).dataset.active
  })
  splitDownloadMenu.hidden = true
  btnDownloadArrow.setAttribute('aria-expanded', 'false')
})

document.addEventListener('click', () => {
  if (!splitDownloadMenu.hidden) {
    splitDownloadMenu.hidden = true
    btnDownloadArrow.setAttribute('aria-expanded', 'false')
  }
  if (!splitUploadMenu.hidden) {
    splitUploadMenu.hidden = true
    btnUploadDeviceArrow.setAttribute('aria-expanded', 'false')
  }
})

btnUploadDeviceArrow.addEventListener('click', (e) => {
  e.stopPropagation()
  const open = !splitUploadMenu.hidden
  splitUploadMenu.hidden = open
  btnUploadDeviceArrow.setAttribute('aria-expanded', String(!open))
})

function setBleConnected(connected: boolean) {
  btnConnectDevice.classList.toggle('split-option--muted', connected)
  btnDisconnectDevice.classList.toggle('split-option--muted', !connected)
  bleStatus.classList.toggle('connected', connected)
  bleStatusText.textContent = connected ? 'Connected' : 'Not connected'
}

function bleDisconnect() {
  if (bleState?.protocol === 'opendisplay') {
    bleState.char.service.device.gatt?.disconnect()
  } else if (bleState?.protocol === 'gicisky') {
    bleState.conn.device.gatt?.disconnect()
  }
  bleState = null
  setBleConnected(false)
}

async function doConnect() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth is not available in this browser. Try Chrome or Edge.')
    return
  }
  bleStatusText.textContent = 'Connecting…'
  try {
    if (bleProtocol === 'opendisplay') {
      const char = await bleConnect()
      bleState = { protocol: 'opendisplay', char }
      setBleConnected(true)
      char.service.device.addEventListener('gattserverdisconnected', () => {
        bleState = null
        setBleConnected(false)
      })
    } else {
      const conn = await giciskyConnect(giciskyDeviceInfo(presetSelect.value))
      bleState = { protocol: 'gicisky', conn }
      setBleConnected(true)
      conn.device.addEventListener('gattserverdisconnected', () => {
        bleState = null
        setBleConnected(false)
      })
    }
  } catch (err: unknown) {
    bleState = null
    setBleConnected(false)
  }
}

splitUploadMenu.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.split-option')
  if (!btn || btn.classList.contains('split-option--muted')) return
  splitUploadMenu.hidden = true
  btnUploadDeviceArrow.setAttribute('aria-expanded', 'false')

  const proto = btn.dataset.protocol as 'opendisplay' | 'gicisky' | undefined
  if (proto) {
    if (proto !== bleProtocol) {
      bleDisconnect()
      bleProtocol = proto
      const label = proto === 'opendisplay' ? '↑ OpenDisplay BLE' : '↑ Gicisky BLE'
      btnUploadDevice.textContent = label
      delete btnProtocolOpenDisplay.dataset.active
      delete btnProtocolGicisky.dataset.active
      ;(proto === 'opendisplay' ? btnProtocolOpenDisplay : btnProtocolGicisky).dataset.active = ''
      updateExportButtons()
    }
  } else if (btn.id === 'btnConnectDevice') {
    doConnect()
  } else if (btn.id === 'btnDisconnectDevice') {
    bleDisconnect()
  }
})

btnUploadDevice.addEventListener('click', async () => {
  const img = images.find(i => i.id === activeId)
  if (!img?.ideal) return
  if (!navigator.bluetooth) {
    alert('Web Bluetooth is not available in this browser. Try Chrome or Edge.')
    return
  }

  const preset = DISPLAY_PRESETS.find(p => p.id === presetSelect.value)
  if (preset && preset.id !== 'custom') {
    const deg = parseInt(bleRotation.value)
    const outW = (deg === 90 || deg === 270) ? displayHeight : displayWidth
    const outH = (deg === 90 || deg === 270) ? displayWidth  : displayHeight
    if (outW !== preset.width || outH !== preset.height) {
      const ok = confirm(
        `Rotation mismatch: the current rotation outputs ${outW}×${outH} px but the device expects ${preset.width}×${preset.height} px.\n\nUpload anyway?`
      )
      if (!ok) return
    }
  }

  const originalLabel = btnUploadDevice.textContent ?? '↑ OpenDisplay BLE'
  btnUploadDevice.classList.add('btn-sending')
  btnUploadDeviceArrow.disabled = true

  const isConnected = () => bleState?.protocol === 'opendisplay'
    ? bleState.char.service.device.gatt?.connected ?? false
    : bleState?.protocol === 'gicisky'
      ? bleState.conn.device.gatt?.connected ?? false
      : false

  try {
    if (!bleState || !isConnected()) {
      btnUploadDevice.textContent = '↑ Connecting…'
      await doConnect()
      if (!bleState) {
        btnUploadDevice.classList.remove('btn-sending')
        btnUploadDevice.textContent = originalLabel
        updateExportButtons()
        return
      }
    }

    const toEncode = rotatePixels(img.ideal.data, img.width, img.height, parseInt(bleRotation.value))

    if (bleState.protocol === 'opendisplay') {
      const imageBytes = bleEncode(toEncode.data, toEncode.width, toEncode.height, paletteGroupId)
      await bleSend(bleState.char, imageBytes, (sent, total) => {
        btnUploadDevice.textContent = `↑ Sending ${Math.round((sent / total) * 100)}%…`
      })
    } else {
      const imageBytes = giciskyEncode(toEncode.data, toEncode.width, toEncode.height, paletteGroupId, bleState.conn.deviceInfo)
      await gickySend(bleState.conn, imageBytes, (sent, total) => {
        btnUploadDevice.textContent = `↑ Sending ${Math.round((sent / total) * 100)}%…`
      })
      // Gicisky devices only start the display refresh after the BLE connection is dropped.
      // gattserverdisconnected will fire once the physical link drops and update the UI.
      bleState.conn.device.gatt?.disconnect()
    }

    btnUploadDevice.classList.remove('btn-sending')
    btnUploadDevice.textContent = '✓ Sent'
    setTimeout(() => {
      btnUploadDevice.textContent = originalLabel
      updateExportButtons()
    }, 2000)
  } catch (err: unknown) {
    bleState = null
    setBleConnected(false)
    const msg = err instanceof Error ? err.message : String(err)
    btnUploadDevice.classList.remove('btn-sending')
    if (!msg.toLowerCase().includes('cancel') && !msg.toLowerCase().includes('user')) {
      btnUploadDevice.textContent = '✗ Error'
      setTimeout(() => {
        btnUploadDevice.textContent = originalLabel
        updateExportButtons()
      }, 2500)
    } else {
      btnUploadDevice.textContent = originalLabel
      updateExportButtons()
    }
  }
})

btnDownloadZip.addEventListener('click', async () => {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()

  for (const img of images) {
    // Process if not yet done
    if (!img.dithered) {
      const palette = getPaletteVariant(paletteGroupId, calibrationVariantId)
      const bmp = await createImageBitmap(img.original)
      const r = runPipeline({
        source: bmp,
        srcWidth: img.original.width,
        srcHeight: img.original.height,
        dstWidth: displayWidth,
        dstHeight: displayHeight,
        resizeMode,
        palette,
        settings,
      })
      bmp.close()
      img.dithered = r.measured
      img.ideal = r.ideal
      img.width = displayWidth
      img.height = displayHeight
    }
    const ideal = img.ideal
    if (!ideal) continue
    const blob = await imageDataToBlob(applyRotationToImageData(ideal))
    zip.file(stripExt(img.name) + '_dithered.png', blob)
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' })
  downloadBlob(zipBlob, 'opendithering_export.zip')
})

function imageDataToBmpBlob(data: ImageData): Blob {
  const { width: W, height: H } = data
  const rowStride = Math.ceil(W * 3 / 4) * 4  // rows padded to 4-byte boundary
  const pixelDataSize = rowStride * H
  const buf = new ArrayBuffer(54 + pixelDataSize)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)

  // BMP file header
  bytes[0] = 0x42; bytes[1] = 0x4D               // 'BM'
  view.setUint32(2, 54 + pixelDataSize, true)     // file size
  view.setUint32(6, 0, true)                      // reserved
  view.setUint32(10, 54, true)                    // pixel data offset

  // BITMAPINFOHEADER
  view.setUint32(14, 40, true)                    // header size
  view.setInt32(18, W, true)                      // width
  view.setInt32(22, H, true)                      // height (positive = bottom-to-top)
  view.setUint16(26, 1, true)                     // color planes
  view.setUint16(28, 24, true)                    // bits per pixel
  view.setUint32(30, 0, true)                     // BI_RGB (no compression)
  view.setUint32(34, pixelDataSize, true)
  // remaining DIB fields (resolution, palette) left as 0

  // Pixel data: bottom-to-top rows, BGR channel order
  const src = data.data
  for (let y = 0; y < H; y++) {
    const dstRow = 54 + (H - 1 - y) * rowStride
    const srcRow = y * W * 4
    for (let x = 0; x < W; x++) {
      const s = srcRow + x * 4
      const d = dstRow + x * 3
      bytes[d]     = src[s + 2]  // B
      bytes[d + 1] = src[s + 1]  // G
      bytes[d + 2] = src[s]      // R
    }
  }

  return new Blob([buf], { type: 'image/bmp' })
}

function applyRotationToImageData(data: ImageData): ImageData {
  const deg = parseInt(bleRotation.value)
  if (deg === 0) return data
  const r = rotatePixels(data.data, data.width, data.height, deg)
  const copy = new Uint8ClampedArray(r.data.length)
  copy.set(r.data)
  return new ImageData(copy, r.width, r.height)
}

function imageDataToBlob(data: ImageData): Promise<Blob> {
  const c = document.createElement('canvas')
  c.width = data.width; c.height = data.height
  c.getContext('2d')!.putImageData(data, 0, 0)
  return new Promise(resolve => c.toBlob(b => resolve(b!), 'image/png'))
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

// ── Zoom / pan ─────────────────────────────────────────────────────────────

let zoomed = false
let panX = 0
let panY = 0
let dragStart: { mouseX: number; mouseY: number; panX: number; panY: number } | null = null
let dragMoved = 0

function applyPan() {
  const t = `translate(${-panX}px, ${-panY}px)`
  canvasOrig.style.transform = t
  canvasDith.style.transform = t
}

function clampPan(x: number, y: number): [number, number] {
  const vw = viewportOrig.clientWidth
  const vh = viewportOrig.clientHeight
  const cw = canvasDith.width
  const ch = canvasDith.height
  return [
    Math.round(Math.min(Math.max(x, 0), Math.max(0, cw - vw))),
    Math.round(Math.min(Math.max(y, 0), Math.max(0, ch - vh))),
  ]
}

function enterZoom(imgX: number, imgY: number) {
  const vw = viewportOrig.clientWidth
  // Cap frozen height to the canvas's 1:1 pixel height. Without this, portrait
  // images produce a viewport taller than the canvas, leaving empty click area
  // below that immediately exits zoom mode.
  const zoomH = Math.min(viewportOrig.clientHeight, canvasDith.height)
  viewportOrig.style.height = `${zoomH}px`
  viewportDith.style.height = `${zoomH}px`

  viewportOrig.classList.add('zoomed')
  viewportDith.classList.add('zoomed')
  zoomed = true

  // Portrait images at 1:1 may be narrower/shorter than the viewport — no
  // panning is possible. Use zoom-out cursor so the click-to-return hint is clear.
  const canPan = canvasDith.width > vw || canvasDith.height > zoomH
  viewportOrig.classList.toggle('no-pan', !canPan)
  viewportDith.classList.toggle('no-pan', !canPan)

  ;[panX, panY] = clampPan(imgX - vw / 2, imgY - zoomH / 2)
  applyPan()
}

function exitZoom() {
  zoomed = false
  viewportOrig.classList.remove('zoomed', 'no-pan')
  viewportDith.classList.remove('zoomed', 'no-pan')
  viewportOrig.style.height = ''
  viewportDith.style.height = ''
  panX = 0; panY = 0
  canvasOrig.style.transform = ''
  canvasDith.style.transform = ''
}

function setupViewportListeners(viewport: HTMLDivElement, canvas: HTMLCanvasElement) {
  viewport.addEventListener('mousedown', e => {
    if (!zoomed || viewportOrig.classList.contains('no-pan')) return
    e.preventDefault()
    dragStart = { mouseX: e.clientX, mouseY: e.clientY, panX, panY }
    dragMoved = 0
    viewportOrig.classList.add('dragging')
    viewportDith.classList.add('dragging')
  })

  viewport.addEventListener('click', e => {
    if (dragMoved > 5) return
    if (zoomed) {
      exitZoom()
      return
    }
    if (!canvas.width) return
    // Convert click position to canvas pixel coordinates
    const rect = canvas.getBoundingClientRect()
    const imgX = (e.clientX - rect.left) * (canvas.width  / rect.width)
    const imgY = (e.clientY - rect.top)  * (canvas.height / rect.height)
    enterZoom(imgX, imgY)
  })
}

setupViewportListeners(viewportOrig, canvasOrig)
setupViewportListeners(viewportDith, canvasDith)

document.addEventListener('mousemove', e => {
  if (!dragStart) return
  const dx = e.clientX - dragStart.mouseX
  const dy = e.clientY - dragStart.mouseY
  dragMoved = Math.abs(dx) + Math.abs(dy)
  ;[panX, panY] = clampPan(dragStart.panX - dx, dragStart.panY - dy)
  applyPan()
})

document.addEventListener('mouseup', () => {
  if (!dragStart) return
  dragStart = null
  viewportOrig.classList.remove('dragging')
  viewportDith.classList.remove('dragging')
})

// ── Init ──────────────────────────────────────────────────────────────────

populateSelects()
syncSlidersFromSettings()
updatePaletteBadge()
renderSwatches()

// Set initial display preset
buildCascadeMenu()
presetSelect.value = 'seeed-reterminal-e1002'
updatePresetLabel()

// ── Tooltips ──────────────────────────────────────────────────────────────────
{
  const tt = document.createElement('div')
  tt.id = 'tooltip'
  tt.hidden = true
  document.body.appendChild(tt)
  let cur: HTMLElement | null = null

  document.addEventListener('mouseover', e => {
    const t = (e.target as Element).closest<HTMLElement>('[data-tooltip]')
    if (t === cur) return
    cur = t ?? null
    tt.hidden = true
    if (!t) return
    tt.textContent = t.dataset.tooltip!
    const r = t.getBoundingClientRect()
    const left = Math.max(4, Math.min(r.left, window.innerWidth - 244))
    tt.style.left = `${left}px`
    tt.style.top = `${r.bottom + 5}px`
    tt.hidden = false
  })
}
setDimsEditable(false)
