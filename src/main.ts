import type { ProcessingSettings, ResizeMode, PresetName, ImageFile } from './types'
import { PRESETS, BALANCED_PRESET } from './types'
import { DISPLAY_PRESETS } from './displays/presets'
import { getAllPaletteGroups, getPaletteGroup, getPaletteVariant } from './palettes/index'
import { getAllAlgorithms } from './dithering/index'
import { runPipeline } from './processing/pipeline'
import { autoTune } from './processing/autotune'
import type { AutoTuneDebug } from './processing/autotune'
import { isSupported as bleIsSupported, connectDevice as bleConnect, encodeImage as bleEncode, sendImage as bleSend } from './ble/opendisplay'
import { isSupported as giciskyIsSupported, connectDevice as giciskyConnect, encodeImage as giciskyEncode, sendImage as gickySend } from './ble/gicisky'
import type { GiciskyConnection } from './ble/gicisky'

// ── State ──────────────────────────────────────────────────────────────────

let images: ImageFile[] = []
let activeId: string | null = null
let settings: ProcessingSettings = { ...BALANCED_PRESET }
let resizeMode: ResizeMode = 'cover'
let displayWidth = 800
let displayHeight = 480
let paletteGroupId       = 'spectra6'
let calibrationVariantId = 'spectra6-aitjcize'
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
const colorSpaceLabel: Record<string, string> = { rgb: 'RGB', cielab: 'CIELAB', oklab: 'OKLab' }
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
const debugAutoTune    = el<HTMLDivElement>('debugAutoTune')
const dbgSummary       = el<HTMLSpanElement>('dbgSummary')
const dbgRefL          = el<HTMLTableCellElement>('dbgRefL')
const dbgRefC          = el<HTMLTableCellElement>('dbgRefC')
const dbgInitL         = el<HTMLTableCellElement>('dbgInitL')
const dbgInitC         = el<HTMLTableCellElement>('dbgInitC')
const dbgFinalL        = el<HTMLTableCellElement>('dbgFinalL')
const dbgFinalC        = el<HTMLTableCellElement>('dbgFinalC')
const dbgInitLoss      = el<HTMLTableCellElement>('dbgInitLoss')
const dbgFinalLoss     = el<HTMLTableCellElement>('dbgFinalLoss')
const dbgSatBefore     = el<HTMLTableCellElement>('dbgSatBefore')
const dbgSatAfter      = el<HTMLTableCellElement>('dbgSatAfter')
const dbgExpBefore     = el<HTMLTableCellElement>('dbgExpBefore')
const dbgExpAfter      = el<HTMLTableCellElement>('dbgExpAfter')
const dbgHCRow         = el<HTMLTableRowElement>('dbgHCRow')
const dbgHCBefore      = el<HTMLTableCellElement>('dbgHCBefore')
const dbgHCAfter       = el<HTMLTableCellElement>('dbgHCAfter')
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
}

function autoOrientDisplay(imgW: number, imgH: number) {
  const imgPortrait  = imgH > imgW
  const dispPortrait = displayHeight > displayWidth
  if (imgPortrait !== dispPortrait) {
    ;[displayWidth, displayHeight] = [displayHeight, displayWidth]
    dimWidth.value  = String(displayWidth)
    dimHeight.value = String(displayHeight)
    bleRotation.value = '270'
    invalidateAll()
  } else {
    bleRotation.value = '0'
  }
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
  }
  invalidateAll()
  scheduleProcess()
})

dimWidth.addEventListener('input', () => {
  displayWidth = parseInt(dimWidth.value) || 800
  invalidateAll(); scheduleProcess()
})
dimHeight.addEventListener('input', () => {
  displayHeight = parseInt(dimHeight.value) || 480
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
function sliderSetup(
  sliderId: string,
  valId: string,
  scale: number,
  key: keyof ProcessingSettings,
  decimals = 1,
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

  valEl.title = 'Double-click to reset'
  valEl.addEventListener('dblclick', () => {
    const defaultVal = (getResetDefaults() as unknown as Record<string, number>)[key as string]
    slider.value = String(Math.round(defaultVal * scale))
    ;(settings as unknown as Record<string, number>)[key as string] = defaultVal
    valEl.textContent = defaultVal.toFixed(decimals)
    markCustomPreset(); invalidateAll(); scheduleProcess()
  })
}

sliderSetup('sliderExposure', 'valExposure', 100, 'exposure')
sliderSetup('sliderSaturation', 'valSaturation', 100, 'saturation')
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
(el<HTMLSpanElement>('valDitherStrength') as HTMLElement).title = 'Double-click to reset'
el<HTMLSpanElement>('valDitherStrength').addEventListener('dblclick', () => {
  const v = getResetDefaults().ditherStrength
  el<HTMLInputElement>('sliderDitherStrength').value = String(Math.round(v * 100))
  settings.ditherStrength = v
  el<HTMLSpanElement>('valDitherStrength').textContent = String(Math.round(v * 100)) + '%'
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

el<HTMLInputElement>('sliderKnoxAlpha').addEventListener('input', () => {
  const pct = parseInt(el<HTMLInputElement>('sliderKnoxAlpha').value)
  settings.knoxAlpha = pct / 100
  el<HTMLSpanElement>('valKnoxAlpha').textContent = (pct / 100).toFixed(2)
  markCustomPreset(); invalidateAll(); scheduleProcess()
});
(el<HTMLSpanElement>('valKnoxAlpha') as HTMLElement).title = 'Double-click to reset'
el<HTMLSpanElement>('valKnoxAlpha').addEventListener('dblclick', () => {
  const v = getResetDefaults().knoxAlpha
  el<HTMLInputElement>('sliderKnoxAlpha').value = String(Math.round(v * 100))
  settings.knoxAlpha = v
  el<HTMLSpanElement>('valKnoxAlpha').textContent = v.toFixed(2)
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

el<HTMLInputElement>('sliderKnoxFringe').addEventListener('input', () => {
  const v = parseInt(el<HTMLInputElement>('sliderKnoxFringe').value)
  settings.knoxFringe = v / 100
  el<HTMLSpanElement>('valKnoxFringe').textContent = (v / 100).toFixed(2)
  markCustomPreset(); invalidateAll(); scheduleProcess()
});
(el<HTMLSpanElement>('valKnoxFringe') as HTMLElement).title = 'Double-click to reset'
el<HTMLSpanElement>('valKnoxFringe').addEventListener('dblclick', () => {
  const v = getResetDefaults().knoxFringe
  el<HTMLInputElement>('sliderKnoxFringe').value = String(Math.round(v * 100))
  settings.knoxFringe = v
  el<HTMLSpanElement>('valKnoxFringe').textContent = v.toFixed(2)
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

el<HTMLInputElement>('sliderKnoxEdge').addEventListener('input', () => {
  const v = parseInt(el<HTMLInputElement>('sliderKnoxEdge').value)
  settings.knoxEdgeSensitivity = v / 100
  el<HTMLSpanElement>('valKnoxEdge').textContent = (v / 100).toFixed(1)
  markCustomPreset(); invalidateAll(); scheduleProcess()
});
(el<HTMLSpanElement>('valKnoxEdge') as HTMLElement).title = 'Double-click to reset'
el<HTMLSpanElement>('valKnoxEdge').addEventListener('dblclick', () => {
  const v = getResetDefaults().knoxEdgeSensitivity
  el<HTMLInputElement>('sliderKnoxEdge').value = String(Math.round(v * 100))
  settings.knoxEdgeSensitivity = v
  el<HTMLSpanElement>('valKnoxEdge').textContent = v.toFixed(1)
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

el<HTMLInputElement>('sliderRiemersmaQueue').addEventListener('input', () => {
  const v = parseInt(el<HTMLInputElement>('sliderRiemersmaQueue').value)
  settings.riemersmaQueueSize = v
  el<HTMLSpanElement>('valRiemersmaQueue').textContent = String(v)
  markCustomPreset(); invalidateAll(); scheduleProcess()
});
(el<HTMLSpanElement>('valRiemersmaQueue') as HTMLElement).title = 'Double-click to reset'
el<HTMLSpanElement>('valRiemersmaQueue').addEventListener('dblclick', () => {
  const v = getResetDefaults().riemersmaQueueSize
  el<HTMLInputElement>('sliderRiemersmaQueue').value = String(v)
  settings.riemersmaQueueSize = v
  el<HTMLSpanElement>('valRiemersmaQueue').textContent = String(v)
  markCustomPreset(); invalidateAll(); scheduleProcess()
})

el<HTMLInputElement>('sliderDizzyDiagonal').addEventListener('input', () => {
  const v = parseInt(el<HTMLInputElement>('sliderDizzyDiagonal').value)
  settings.dizzyDiagonalWeight = v / 100
  el<HTMLSpanElement>('valDizzyDiagonal').textContent = (v / 100).toFixed(2)
  markCustomPreset(); invalidateAll(); scheduleProcess()
});
(el<HTMLSpanElement>('valDizzyDiagonal') as HTMLElement).title = 'Double-click to reset'
el<HTMLSpanElement>('valDizzyDiagonal').addEventListener('dblclick', () => {
  const v = getResetDefaults().dizzyDiagonalWeight
  el<HTMLInputElement>('sliderDizzyDiagonal').value = String(Math.round(v * 100))
  settings.dizzyDiagonalWeight = v
  el<HTMLSpanElement>('valDizzyDiagonal').textContent = v.toFixed(2)
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
  btnAutoTune.textContent = 'Tuning…'
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

  const palette = getPaletteVariant(paletteGroupId, calibrationVariantId)
  const srcBitmap = await createImageBitmap(img.original)
  const result = autoTune(
    {
      source: srcBitmap,
      srcWidth: img.original.width,
      srcHeight: img.original.height,
      dstWidth: displayWidth,
      dstHeight: displayHeight,
      resizeMode,
      palette,
      settings,
    },
    settings.saturation,
    settings.exposure,
    settings.highlightCompress,
  )
  srcBitmap.close()

  settings.saturation = result.saturation
  settings.exposure = result.exposure
  settings.highlightCompress = result.highlightCompress
  markCustomPreset()
  syncSlidersFromSettings()
  invalidateAll()
  scheduleProcess()
  showAutoTuneDebug(result.debug)

  btnAutoTune.disabled = false
  btnAutoTune.textContent = 'Auto-tune'
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
  const [errSpace, distSpace] = value.split('_') as [import('./types').ColorSpace, import('./types').ColorSpace]
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
  el<HTMLSpanElement>(valId).textContent = displayVal.toFixed(1)
}

// ── Invalidation ──────────────────────────────────────────────────────────

function invalidateAll() {
  for (const img of images) img.dithered = null
}

// ── Auto-tune debug panel ─────────────────────────────────────────────────

function showAutoTuneDebug(d: AutoTuneDebug) {
  const f3 = (n: number) => n.toFixed(3)
  const f2 = (n: number) => n.toFixed(2)

  const iters = d.iterationsRun
  const statusLabel = iters === 0
    ? 'no change (already optimal)'
    : `${iters} iteration${iters !== 1 ? 's' : ''} · ${d.converged ? 'converged' : 'hit limit'}`
  dbgSummary.textContent = statusLabel

  dbgRefL.textContent   = f3(d.refStats.meanL)
  dbgRefC.textContent   = f3(d.refStats.meanC)
  dbgInitL.textContent  = f3(d.initialStats.meanL)
  dbgInitC.textContent  = f3(d.initialStats.meanC)
  dbgFinalL.textContent = f3(d.finalStats.meanL)
  dbgFinalC.textContent = f3(d.finalStats.meanC)
  dbgInitLoss.textContent  = f3(d.initialLoss)
  dbgFinalLoss.textContent = f3(d.finalLoss)

  dbgSatBefore.textContent = f2(d.initialSaturation)
  dbgSatAfter.textContent  = f2(d.finalSaturation)
  dbgExpBefore.textContent = f2(d.initialExposure)
  dbgExpAfter.textContent  = f2(d.finalExposure)

  dbgHCRow.hidden = d.toneMode !== 'scurve'
  dbgHCBefore.textContent = f2(d.initialHighlightCompress)
  dbgHCAfter.textContent  = f2(d.finalHighlightCompress)

  dbgLossHistory.textContent = d.lossHistory.map(f3).join(' → ')

  debugAutoTune.hidden = false
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
  if (downloadFormat === 'bmp') {
    downloadBlob(imageDataToBmpBlob(img.ideal), stripExt(img.name) + '_dithered.bmp')
  } else {
    downloadBlob(await imageDataToBlob(img.ideal), stripExt(img.name) + '_dithered.png')
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
      const conn = await giciskyConnect()
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

  const originalLabel = btnUploadDevice.textContent ?? '↑ OpenDisplay BLE'
  btnUploadDevice.disabled = true
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
      if (!bleState) return
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
    }

    btnUploadDevice.textContent = '✓ Sent'
    setTimeout(() => {
      btnUploadDevice.textContent = originalLabel
      updateExportButtons()
    }, 2000)
  } catch (err: unknown) {
    bleState = null
    setBleConnected(false)
    const msg = err instanceof Error ? err.message : String(err)
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
      ;img.ideal = r.ideal
    }
    const ideal = img.ideal
    if (!ideal) continue
    const blob = await imageDataToBlob(ideal)
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
setDimsEditable(false)
