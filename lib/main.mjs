// Loaded as a module between pdf.mjs and viewer.mjs, so the listeners below
// are in place before the viewer starts up.

function loadConfig() {
  const elem = document.getElementById('pdf-preview-config')
  if (elem) {
    return JSON.parse(elem.getAttribute('data-config'))
  }
  throw new Error('Could not load configuration.')
}
function cursorTools(name) {
  if (name === 'hand') {
    return 1
  }
  return 0
}
function scrollMode(name) {
  switch (name) {
    case 'vertical':
      return 0
    case 'horizontal':
      return 1
    case 'wrapped':
      return 2
    default:
      return -1
  }
}
function spreadMode(name) {
  switch (name) {
    case 'none':
      return 0
    case 'odd':
      return 1
    case 'even':
      return 2
    default:
      return -1
  }
}
function zoomValue(scale) {
  // pdf.js reads numeric zoom values as percentages; the setting is a factor
  const factor = Number(scale)
  return Number.isFinite(factor) && factor > 0 ? String(factor * 100) : scale
}

const config = loadConfig()
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null

// Option kind for getDocument() parameters (OptionKind.API in viewer.mjs)
const API_OPTIONS = 0x04

function configureViewer() {
  const defaults = config.defaults
  const options = PDFViewerApplicationOptions
  options.setAll({
    defaultUrl: '',
    disablePreferences: true,
    enableScripting: false,
    annotationEditorMode: -1,
    localeProperties: { lang: config.lang },
    cMapUrl: config.cMapUrl,
    standardFontDataUrl: config.standardFontDataUrl,
    wasmUrl: config.wasmUrl,
    iccUrl: config.iccUrl,
    imageResourcesPath: config.imageResourcesPath,
    workerSrc: config.workerSrc,
    // Fetch the whole file at once: a document stays complete if the file is
    // deleted, and never mixes bytes from two versions of a rebuilt file.
    disableRange: true,
    cursorToolOnLoad: cursorTools(defaults.cursor),
    defaultZoomValue: zoomValue(defaults.scale),
    sidebarViewOnLoad: defaults.sidebar ? 1 : 0,
    scrollModeOnLoad: scrollMode(defaults.scrollMode),
    spreadModeOnLoad: spreadMode(defaults.spreadMode),
  })

  const app = PDFViewerApplication
  // Reopen where the file was last viewed; this takes precedence over the
  // configured zoom and the view history.
  if (config.position) {
    app.initialBookmark = config.position
  }
  // Key the view history by file path instead of by content, so a rebuilt
  // PDF reopens where the previous version was left.
  const load = app.load
  app.load = function (pdfDocument) {
    pdfDocument._pdfInfo.fingerprints = [config.path]
    clampInitialBookmark(pdfDocument.numPages)
    trackingPosition = false
    return load.call(this, pdfDocument)
  }

  app.initializedPromise.then(() => {
    // The configured defaults apply to the first load only; reloads keep the
    // current view.
    app.eventBus.on('documentinit', () => {
      options.setAll({
        defaultZoomValue: '',
        sidebarViewOnLoad: -1,
        scrollModeOnLoad: -1,
        spreadModeOnLoad: -1,
      })
    }, { once: true })

    // Report the position once each load has applied its initial view
    app.eventBus.on('documentinit', () => {
      trackingPosition = true
    })
    app.eventBus.on('updateviewarea', ({ location }) => {
      if (trackingPosition && location) {
        savePosition(location.pdfOpenParams.replace(/^#/, ''))
      }
    })

    openDocument().then(() => {
      if (reloadPending) {
        requestReload()
      }
    })
  })
}

// pdf.js drops the whole bookmark, zoom included, when its page is out of range
function clampInitialBookmark(numPages) {
  const app = PDFViewerApplication
  if (!app.initialBookmark) {
    return
  }
  const params = new URLSearchParams(app.initialBookmark)
  if (Number(params.get('page')) > numPages) {
    params.set('page', String(numPages))
    app.initialBookmark = decodeURIComponent(params.toString())
  }
}

let trackingPosition = false
let positionTimer = null
function savePosition(position) {
  if (!vscode) {
    return
  }
  clearTimeout(positionTimer)
  positionTimer = setTimeout(() => {
    vscode.postMessage({ type: 'position', position })
  }, 250)
}

// viewer.mjs announces itself on the parent document when it can reach it
// (it can inside a VS Code webview), otherwise on its own document.
let configured = false
function onViewerLoaded(event) {
  if (configured || event.detail?.source !== window) {
    return
  }
  configured = true
  configureViewer()
}
document.addEventListener('webviewerloaded', onViewerLoaded)
try {
  parent.document.addEventListener('webviewerloaded', onViewerLoaded)
} catch {
  // Cross-origin parent: the event is dispatched on our own document.
}

async function reloadDocument() {
  const app = PDFViewerApplication
  const loadingTask = pdfjsLib.getDocument({
    ...PDFViewerApplicationOptions.getAll(API_OPTIONS),
    url: config.path,
  })
  let pdfDocument
  try {
    pdfDocument = await loadingTask.promise
  } catch (error) {
    // Typically a half-written file; keep showing the current version.
    loadingTask.destroy()
    throw error
  }
  // Swap documents without closing the viewer, which would reset the UI.
  // The view history (keyed by path) restores page, zoom and scroll; clamp
  // its page first, as pdf.js drops the whole position when out of range.
  try {
    const page = Number(await app.store?.get('page'))
    if (page > pdfDocument.numPages) {
      await app.store.set('page', pdfDocument.numPages)
    }
  } catch {
    // Without a view history (e.g. no localStorage) there is nothing to clamp.
  }
  const previousTask = app.pdfLoadingTask
  app.pdfLoadingTask = loadingTask
  app.load(pdfDocument)
  previousTask?.destroy()
  showNotice(null)
}

const LOAD_ERROR = 'An error occurred while loading the file. It will be reloaded when the file changes.'

// Message over the viewer: a banner above the document if one is showing
function showNotice(message) {
  let elem = document.getElementById('pdfPreviewNotice')
  if (!message) {
    elem?.remove()
    return
  }
  if (!elem) {
    elem = document.createElement('div')
    elem.id = 'pdfPreviewNotice'
    document.body.append(elem)
  }
  elem.textContent = message
  elem.classList.toggle('banner', documentState === 'loaded')
}

function onFileDeleted() {
  showNotice(documentState === 'loaded'
    ? 'File no longer available. Showing the last loaded version until it is created again.'
    : 'File no longer available. It will be loaded when it is created again.')
}

// 'opening' until the first open settles, then 'loaded' or 'failed'
let documentState = 'opening'

async function openDocument() {
  documentState = 'opening'
  try {
    await PDFViewerApplication.open({ url: config.path })
    documentState = 'loaded'
    showNotice(null)
  } catch {
    documentState = 'failed'
    showNotice(LOAD_ERROR)
  }
}

// Run reloads one at a time; changes that arrive mid-reload collapse into a
// single follow-up reload of the latest file. Until a document has loaded,
// a change retries opening the file instead.
let reloadRunning = false
let reloadPending = false
async function requestReload() {
  reloadPending = true
  if (reloadRunning || documentState === 'opening') {
    return
  }
  reloadRunning = true
  try {
    while (reloadPending) {
      reloadPending = false
      if (documentState === 'loaded') {
        try {
          await reloadDocument()
        } catch (error) {
          console.error('PDF preview reload failed:', error)
        }
      } else {
        await openDocument()
      }
    }
  } finally {
    reloadRunning = false
  }
}

window.addEventListener('message', (event) => {
  switch (event.data?.type) {
    case 'reload':
      requestReload()
      break
    case 'deleted':
      onFileDeleted()
      break
    case 'print':
      PDFViewerApplication.eventBus.dispatch('print', { source: window })
      break
  }
})
