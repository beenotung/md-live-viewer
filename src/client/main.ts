import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import mermaid from 'mermaid'
import katex from 'katex'
// Prism mutates a shared global, so import the core first, then languages.
import Prism from 'prismjs'
import 'prismjs/components/prism-markup'
import 'prismjs/components/prism-clike'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-css'

mermaid.initialize({ startOnLoad: false, theme: 'default' })

let content = document.querySelector<HTMLElement>('#content')!
let currentPath = document.querySelector<HTMLElement>('#currentPath')!
let statusNode = document.querySelector<HTMLElement>('#status')!
let openBtn = document.querySelector<HTMLButtonElement>('#openBtn')!
let toast = document.querySelector<HTMLElement>('#toast')!

let palette = document.querySelector<HTMLDialogElement>('#palette')!
let paletteInput = document.querySelector<HTMLInputElement>('#paletteInput')!
let paletteList = document.querySelector<HTMLUListElement>('#paletteList')!
let paletteEmpty = document.querySelector<HTMLElement>('#paletteEmpty')!
let paletteModeBtn = document.querySelector<HTMLButtonElement>('#paletteMode')!
let paletteModeIcon = document.querySelector<HTMLElement>('#paletteModeIcon')!
let paletteModeLabel = document.querySelector<HTMLElement>('#paletteModeLabel')!

let themeBtn = document.querySelector<HTMLButtonElement>('#themeBtn')!
let themeIcon = document.querySelector<HTMLElement>('#themeIcon')!
let copyPathBtn = document.querySelector<HTMLButtonElement>('#copyPathBtn')!
let copyRawBtn = document.querySelector<HTMLButtonElement>('#copyRawBtn')!
let printBtn = document.querySelector<HTMLButtonElement>('#printBtn')!

let allFiles: string[] = []
let paletteResults: string[] = []
let paletteActiveIndex = 0
let paletteItems: HTMLLIElement[] = []
let paletteSource: string[] = []
let paletteMode: 'list' | 'tree' = 'list'
const expandedDirs = new Set<string>()

let currentFilePath: string | null = null
let currentRaw = ''
let serverRoot = ''
let renderToken = 0
let toastTimeout: number | undefined
let paletteSearchToken = 0

// "Recently changed" tracking (block-level diff with decay).
// A block stays highlighted until it is older than the fade window (time) OR
// more than MAX_RECENT_UPDATES live updates have happened since (whichever
// comes first) — the update cap bounds clutter during edit bursts.
// The fade window is set by the server's `--fade` option and read from
// /api/config (0 disables the highlighting).
let lastUnitKeys: string[] = []
const recentChanges = new Map<string, { at: number; gen: number }>()
let recentTtlMs = 300000
const MAX_RECENT_UPDATES = 5
let updateGeneration = 0
let recentTimer: number | undefined
// Logical clock that pauses while the tab is hidden, so changes never fade
// before the user actually sees them (and relative order is preserved).
let hiddenSince: number | null = null
let pausedMs = 0
function logicalNow(): number {
  return (hiddenSince ?? Date.now()) - pausedMs
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenSince = Date.now()
  } else if (hiddenSince !== null) {
    pausedMs += Date.now() - hiddenSince
    hiddenSince = null
    let now = logicalNow()
    pruneRecent(now)
    applyRecentStyles(now)
  }
})

function showToast(message: string) {
  toast.textContent = message
  toast.classList.add('show')
  clearTimeout(toastTimeout)
  toastTimeout = window.setTimeout(() => toast.classList.remove('show'), 1800)
}

// ---------------------------------------------------------------------------
// Markdown rendering (ported from html-markdown-editor for feature parity)
// ---------------------------------------------------------------------------

function markdownToHtml(markdownText: string) {
  let { markdownText: source, iconLinkBlocks } = extractIconLinks(markdownText)

  let html = micromark(source, {
    allowDangerousHtml: true,
    // avoid treating `~$2 / (~$16)` as strikethrough; `~~this~~` still works
    extensions: [gfm({ singleTilde: false })],
    htmlExtensions: [gfmHtml()],
  })

  for (let { placeholder, html: blockHtml } of iconLinkBlocks) {
    html = html.replace(placeholder, blockHtml)
  }

  let container = document.createElement('div')
  container.innerHTML = html
  container.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.removeAttribute('disabled')
  })
  return container.innerHTML.trim()
}

function extractIconLinks(markdownText: string) {
  markdownText = markdownText.replace(
    /\[(\s*<svg[\s\S]*?<\/svg>\s*)\]\((\S+?)(?:\s+(?:"([^"]*)"|'([^']*)'))?\)/gi,
    (_, svg, url, title1, title2) => {
      let title = title1 || title2
      let titleAttr = title ? ` title="${title}"` : ''
      return `<a href="${url}"${titleAttr}>${svg.trim()}</a>`
    },
  )

  let iconLinkBlocks: { placeholder: string; html: string }[] = []
  markdownText = markdownText.replace(
    /<a\s[^>]*>[\s\S]*?<svg[\s\S]*?<\/svg>[\s\S]*?<\/a>/gi,
    (html, offset: number) => {
      let lineStart = markdownText.lastIndexOf('\n', offset - 1) + 1
      let lineEnd = markdownText.indexOf('\n', offset)
      if (lineEnd == -1) lineEnd = markdownText.length
      let line = markdownText.slice(lineStart, lineEnd)
      let entireLine = line.replace(html, '').trim().length == 0
      let placeholder = `%%ICON_LINK_${iconLinkBlocks.length + 1}%%`
      html = html.replace(/>\s+</g, '><').trim()
      iconLinkBlocks.push({ placeholder, html })
      return entireLine ? `\n\n${placeholder}\n\n` : placeholder
    },
  )
  return { markdownText, iconLinkBlocks }
}

function normalizeTableCells(container: HTMLElement) {
  let changed = true
  while (changed) {
    changed = false
    container.querySelectorAll('th,td').forEach(cell => {
      for (;;) {
        let child = cell.lastElementChild
        if (!child || !isEmptyBlock(child)) break
        child.remove()
        changed = true
      }
      if (cell.childNodes.length !== 1) return
      let child = cell.firstElementChild
      if (!child) return
      let tagName = child.tagName.toLowerCase()
      if (tagName !== 'p' && tagName !== 'div') return
      if (child.closest('pre,code,.katex,.katex-inline,.katex-block')) return
      child.outerHTML = child.innerHTML
      changed = true
    })
  }
}

function isEmptyBlock(node: Node | null): boolean {
  if (!(node instanceof HTMLElement)) return false
  if (!node.parentElement) return false
  let tagName = node.tagName.toLowerCase()
  if (tagName !== 'p' && tagName !== 'div') return false
  let html = node.innerHTML.trim()
  return html.length === 0 || html === '<br>'
}

function renderLatex(container: HTMLElement) {
  // Unwrap <pre><code>…$$…</code></pre> written as a code block for display math.
  let html = container.innerHTML
  html = html.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_, inner) => {
    if (inner.includes('$$')) return inner
    return `<pre><code>${inner}</code></pre>`
  })
  container.innerHTML = html

  // Render both $$block$$ and $inline$ math, per text node, skipping code
  // contexts — so `$$block$$` written as inline code stays literal.
  let mathPattern =
    /\$\$([\s\S]+?)\$\$|(?<![A-Za-z$])\$([^\$\n]+?)\$(?!\$|\d)/g
  let walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let textNodes: Text[] = []
  for (;;) {
    let node = walker.nextNode()
    if (!node) break
    let parent = node.parentElement
    if (!parent) continue
    if (parent.closest('pre, code, math, .katex-inline, .katex-block')) continue
    textNodes.push(node as Text)
  }
  for (let textNode of textNodes) {
    let text = textNode.textContent ?? ''
    let replaced = text.replace(
      mathPattern,
      (full, blockMath: string | undefined, inlineMath: string | undefined) => {
        try {
          if (blockMath !== undefined) {
            let math = blockMath.trim()
            if (!math) return ''
            let rendered = katex.renderToString(math, {
              displayMode: true,
              throwOnError: false,
            })
            return `<div class="katex-block" style="display:flex;justify-content:center;padding:0.5rem;">${rendered}</div>`
          }
          if (!inlineMath) return full
          let rendered = katex.renderToString(inlineMath, {
            displayMode: false,
            throwOnError: false,
          })
          return `<span class="katex-inline">${rendered}</span>`
        } catch {
          return full
        }
      },
    )
    if (replaced === text) continue
    let template = document.createElement('span')
    template.innerHTML = replaced
    textNode.replaceWith(...Array.from(template.childNodes))
  }
}

let mermaidCounter = 0
async function renderMermaid(container: HTMLElement) {
  let elements = container.querySelectorAll(
    'pre.language-mermaid, code.language-mermaid',
  )
  for (let code of elements) {
    let pre =
      code.tagName === 'PRE'
        ? (code as HTMLPreElement)
        : (code.closest('pre') as HTMLPreElement)
    if (!pre) continue
    let source = code.textContent || ''
    if (!source.trim()) continue
    let id = `mermaid-${++mermaidCounter}`
    try {
      let { svg } = await mermaid.render(id, source)
      let div = document.createElement('div')
      div.className = 'mermaid-diagram'
      div.innerHTML = svg
      pre.replaceWith(div)
    } catch (error) {
      console.error('Mermaid render error:', error)
    }
  }
}

// ---------------------------------------------------------------------------
// "Recently changed" highlighting (block-level diff + time decay)
// ---------------------------------------------------------------------------

/** Units are top-level blocks; a list's items and a table's rows are units too. */
function changeUnits(): { el: HTMLElement; key: string }[] {
  let units: { el: HTMLElement; key: string }[] = []
  let add = (el: HTMLElement) => units.push({ el, key: blockKey(el) })
  for (let el of Array.from(content.children) as HTMLElement[]) {
    let tag = el.tagName.toLowerCase()
    if (tag === 'ul' || tag === 'ol') {
      for (let item of Array.from(el.children) as HTMLElement[]) add(item)
    } else if (tag === 'table') {
      for (let row of Array.from(el.querySelectorAll('tr')) as HTMLElement[]) add(row)
    } else {
      add(el)
    }
  }
  return units
}

function blockKey(el: HTMLElement): string {
  let text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return `${el.tagName.toLowerCase()}\u0000${text}`
}

/** A change is still "recent" if it's young enough in both time and updates. */
function isRecent(entry: { at: number; gen: number }, now: number): boolean {
  return (
    recentTtlMs > 0 &&
    now - entry.at <= recentTtlMs &&
    updateGeneration - entry.gen <= MAX_RECENT_UPDATES
  )
}

function pruneRecent(now: number) {
  for (let [key, entry] of recentChanges) {
    if (!isRecent(entry, now)) recentChanges.delete(key)
  }
}

function applyRecentStyles(now: number) {
  for (let { el, key } of changeUnits()) {
    let entry = recentChanges.get(key)
    if (!entry || !isRecent(entry, now)) {
      if (el.style.backgroundColor) el.style.removeProperty('background-color')
      el.classList.remove('recently-changed')
      continue
    }
    let intensity = Math.max(0, 1 - (now - entry.at) / recentTtlMs)
    el.classList.add('recently-changed')
    el.style.backgroundColor = `rgba(34, 197, 94, ${(intensity * 0.16).toFixed(3)})`
  }
}

function ensureRecentTimer() {
  if (recentTimer !== undefined) return
  recentTimer = window.setInterval(() => {
    let now = logicalNow()
    pruneRecent(now)
    applyRecentStyles(now)
    if (recentChanges.size === 0) {
      clearInterval(recentTimer)
      recentTimer = undefined
    }
  }, 500)
}

/**
 * Compare the just-rendered units against the previous render and stamp the
 * new/changed ones. `trackChanges` is false for a freshly opened file (reset
 * baseline, no highlight) and true when re-rendering the same file after a
 * live update.
 */
function updateChangeHighlights(trackChanges: boolean) {
  let units = changeUnits()
  if (!trackChanges) {
    recentChanges.clear()
    lastUnitKeys = units.map(unit => unit.key)
    applyRecentStyles(logicalNow())
    return
  }

  updateGeneration++
  let oldCounts = new Map<string, number>()
  for (let key of lastUnitKeys) oldCounts.set(key, (oldCounts.get(key) ?? 0) + 1)

  let now = logicalNow()
  for (let unit of units) {
    let count = oldCounts.get(unit.key) ?? 0
    if (count > 0) {
      oldCounts.set(unit.key, count - 1) // unchanged — keep its existing timer
    } else {
      recentChanges.set(unit.key, { at: now, gen: updateGeneration }) // added/changed
    }
  }

  lastUnitKeys = units.map(unit => unit.key)
  pruneRecent(now)
  applyRecentStyles(now)
  if (recentChanges.size > 0) ensureRecentTimer()
}

/** Render raw markdown into the content pane. */
async function renderMarkdown(markdownText: string, options: { trackChanges?: boolean } = {}) {
  let token = ++renderToken
  let html = markdownToHtml(markdownText)
  content.innerHTML = html
  normalizeTableCells(content)
  renderLatex(content)
  highlightCodeBlocks(content)
  addCodeCopyButtons(content)
  addInlineCodeCopy(content)
  await renderMermaid(content)
  if (token !== renderToken) return
  rewriteRelativeUrls()
  updateChangeHighlights(options.trackChanges === true)
}

/** Apply Prism syntax highlighting to code blocks. */
function highlightCodeBlocks(container: HTMLElement) {
  for (let code of container.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    // Skip anything Mermaid/KaTeX has already replaced or owns.
    if (code.closest('.mermaid-diagram, .katex, .katex-block')) continue
    let language = (code.className.match(/language-([\w-]+)/)?.[1] ?? '').toLowerCase()
    if (!language || language === 'mermaid') continue
    let grammar = Prism.languages[language]
    if (!grammar) continue
    try {
      code.innerHTML = Prism.highlight(code.textContent ?? '', grammar, language)
      code.parentElement?.classList.add('code-highlighted')
    } catch (error) {
      console.error('Prism highlight error:', error)
    }
  }
}

const CODE_COPY_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>'

/** Add a "copy" button to each code block. */
function addCodeCopyButtons(container: HTMLElement) {
  for (let pre of container.querySelectorAll<HTMLPreElement>('pre')) {
    if (pre.closest('.mermaid-diagram')) continue
    let code = pre.querySelector('code')
    if (!code) continue
    let button = document.createElement('button')
    button.type = 'button'
    button.className = 'code-copy'
    button.innerHTML = CODE_COPY_ICON
    button.title = 'Copy code'
    button.onclick = async () => {
      try {
        await navigator.clipboard.writeText(code!.textContent ?? '')
        button.innerHTML = CHECK_ICON
        showToast('Copied code')
        setTimeout(() => (button.innerHTML = CODE_COPY_ICON), 1200)
      } catch {
        showToast('Clipboard blocked')
      }
    }
    pre.appendChild(button)
  }
}

/**
 * Make plain inline `code` click-to-copy. Skipped inside links (so the link
 * still works) and inside fenced blocks / KaTeX / Mermaid.
 */
function addInlineCodeCopy(container: HTMLElement) {
  for (let code of container.querySelectorAll<HTMLElement>('code')) {
    if (code.closest('pre, a, .katex, .katex-inline, .katex-block, .mermaid-diagram')) {
      continue
    }
    code.classList.add('code-inline-copy')
    code.title = 'Click to copy'
    code.addEventListener('click', async () => {
      // Keep normal text selection (a drag) working.
      if (String(window.getSelection() ?? '').trim().length > 0) return
      try {
        await navigator.clipboard.writeText(code.textContent ?? '')
        showToast('Copied')
        code.classList.add('copied')
        setTimeout(() => code.classList.remove('copied'), 700)
      } catch {
        showToast('Clipboard blocked')
      }
    })
  }
}

/**
 * Rewrite relative image/link URLs so they load through the file server
 * instead of resolving against the viewer's own URL. Links to other markdown
 * files navigate inside the viewer; other files open as raw.
 */
function rewriteRelativeUrls() {
  let baseDir = currentFilePath
    ? currentFilePath.slice(0, currentFilePath.lastIndexOf('/') + 1)
    : ''

  for (let image of content.querySelectorAll<HTMLImageElement>('img[src]')) {
    let value = image.getAttribute('src')
    if (!value || isAbsoluteUrl(value)) continue
    let resolved = resolveRelative(baseDir, value)
    if (resolved) image.setAttribute('src', `/raw/${resolved}`)
  }

  for (let anchor of content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    let value = anchor.getAttribute('href')
    if (!value || value.startsWith('#')) continue
    if (isAbsoluteUrl(value)) {
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noreferrer')
      continue
    }
    let resolved = resolveRelative(baseDir, value)
    if (!resolved) continue
    let withoutAnchor = resolved.split('#')[0]
    if (isMarkdownPath(withoutAnchor)) {
      anchor.setAttribute('href', '#')
      anchor.onclick = event => {
        event.preventDefault()
        if (withoutAnchor) loadFile(withoutAnchor)
      }
      continue
    }
    anchor.setAttribute('href', `/raw/${resolved}`)
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noreferrer')
  }
}

function isAbsoluteUrl(value: string) {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')
}

function isMarkdownPath(filePath: string) {
  return /\.(md|markdown|mdx|mdown|mkd)$/i.test(filePath)
}

/** Resolve `value` relative to `baseDir`, dropping any `#fragment`. */
function resolveRelative(baseDir: string, value: string): string | null {
  try {
    let path = new URL(baseDir + value, 'file:///').pathname
    return decodeURIComponent(path.replace(/^\/+/, ''))
  } catch {
    return null
  }
}

function updateEmptyState() {
  if (currentFilePath) return
  content.innerHTML = /* html */ `<div class="empty">
    <p>No file open.</p>
    <p>Press <kbd>Ctrl</kbd> + <kbd>P</kbd> to search markdown files.</p>
  </div>`
}

// ---------------------------------------------------------------------------
// URL hash — makes the open file bookmarkable / shareable across browsers
// ---------------------------------------------------------------------------

/**
 * Encode a path for the URL fragment, keeping `/` literal (it is a legal
 * fragment character). This keeps links readable — Firefox shows `%2F`
 * verbatim, Chrome decodes it, so literal `/` is consistent in both.
 */
function encodePathForHash(path: string): string {
  return encodeURIComponent(path).replaceAll('%2F', '/')
}

function decodeHashPart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

type HashState = { file: string | null }

/**
 * Read the file path from the URL: `#file=<path>` or the legacy bare
 * `#<path>`. The served root is fixed by the CLI, so only the file is encoded.
 */
function readStateFromHash(): HashState {
  let hash = location.hash.replace(/^#/, '')
  if (!hash) return { file: null }
  if (!hash.includes('=')) {
    // Legacy: bare path.
    return { file: decodeHashPart(hash) }
  }
  let file: string | null = null
  for (let part of hash.split('&')) {
    let separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator) === 'file') {
      file = decodeHashPart(part.slice(separator + 1))
    }
  }
  return { file }
}

function updateUrlHash() {
  let next = currentFilePath ? `#file=${encodePathForHash(currentFilePath)}` : ''
  if (location.hash === next) return
  history.replaceState(null, '', next || location.pathname + location.search)
}

// ---------------------------------------------------------------------------
// Non-Markdown files (images, audio, video, PDF)
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov'])
type MediaKind = 'image' | 'audio' | 'video' | 'pdf'

/** Which built-in viewer fits `filePath`, or null for Markdown / plain text. */
function mediaKind(filePath: string): MediaKind | null {
  let slash = filePath.lastIndexOf('/')
  let dot = filePath.lastIndexOf('.')
  if (dot <= slash) return null
  let ext = filePath.slice(dot + 1).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (ext === 'pdf') return 'pdf'
  return null
}

/** URL that serves `relativePath` raw, with each segment percent-encoded. */
function rawUrl(relativePath: string): string {
  return '/raw/' + relativePath.split('/').map(encodeURIComponent).join('/')
}

/** Lower-case extension without the dot, or '' when there is none. */
function fileExtension(filePath: string): string {
  let slash = filePath.lastIndexOf('/')
  let dot = filePath.lastIndexOf('.')
  return dot > slash ? filePath.slice(dot + 1).toLowerCase() : ''
}

/** Bundled Prism languages, keyed by file extension. */
const CODE_LANGUAGES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python',
  go: 'go', rs: 'rust',
  css: 'css',
  html: 'markup', htm: 'markup', xml: 'markup',
  sql: 'sql',
}

/**
 * Render a non-Markdown text file verbatim — no Markdown interpretation — so
 * `.py`/`.json`/config files are not mangled into headings and emphasis.
 */
function renderPlainText(filePath: string, text: string) {
  let language = CODE_LANGUAGES[fileExtension(filePath)]
  let pre = document.createElement('pre')
  pre.className = 'plain-text'
  let code = document.createElement('code')
  if (language) code.className = `language-${language}`
  code.textContent = text
  pre.append(code)
  content.replaceChildren(pre)
  if (language) highlightCodeBlocks(content)
  addCodeCopyButtons(content)
}

/** Show a non-Markdown file directly (never through the Markdown renderer). */
function renderMedia(kind: MediaKind, relativePath: string) {
  let src = rawUrl(relativePath)
  let name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  let wrap = document.createElement('div')

  if (kind === 'image') {
    wrap.className = 'media-view'
    let img = document.createElement('img')
    img.src = src
    img.alt = name
    wrap.append(img)
  } else if (kind === 'audio' || kind === 'video') {
    wrap.className = 'media-view'
    let card = document.createElement('div')
    card.className = 'media-card'
    let label = document.createElement('div')
    label.className = 'media-name'
    label.textContent = name
    let media: HTMLMediaElement =
      kind === 'audio' ? document.createElement('audio') : document.createElement('video')
    media.controls = true
    media.src = src
    card.append(label, media)
    wrap.append(card)
  } else {
    let frame = document.createElement('iframe')
    frame.className = 'media-frame'
    frame.src = src
    frame.title = name
    wrap.append(frame)
  }

  content.replaceChildren(wrap)
}

/** Point the UI at `path` (title, hash, recents, buttons) without rendering. */
function setCurrentFilePath(path: string) {
  currentFilePath = path
  currentPath.textContent = path
  document.title = `${path} - md-live-viewer`
  localStorage.setItem('md-live-viewer:last', path)
  rememberFile(path)
  updateUrlHash()
  copyPathBtn.disabled = false
  printBtn.disabled = false
  copyPathBtn.title = `Copy path: ${currentAbsolutePath() ?? path}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  let units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

/** Friendly name for common non-previewable types, shown on the card. */
const FILE_KIND: Record<string, string> = {
  pptx: 'PowerPoint', ppt: 'PowerPoint', ppsx: 'PowerPoint', pps: 'PowerPoint',
  docx: 'Word', doc: 'Word', xlsx: 'Excel', xls: 'Excel',
  odt: 'ODF text', ods: 'ODF sheet', odp: 'ODF slides',
  pages: 'Pages', numbers: 'Numbers', key: 'Keynote',
  zip: 'Zip archive', rar: 'RAR archive', '7z': '7z archive', tar: 'Tar archive',
  gz: 'Gzip', tgz: 'Gzip', bz2: 'Bzip2', xz: 'XZ',
  exe: 'Windows app', dll: 'Library', so: 'Library', dylib: 'Library', bin: 'Binary',
  dmg: 'Disk image', iso: 'Disk image', apk: 'Android app', jar: 'Java archive',
  psd: 'Photoshop', ai: 'Illustrator', db: 'Database', sqlite: 'Database',
}

/** Card for a file the viewer cannot display (Office docs, archives, ...). */
function renderUnsupported(relativePath: string, size?: number) {
  let name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  let ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''

  let wrap = document.createElement('div')
  wrap.className = 'media-view'
  let card = document.createElement('div')
  card.className = 'file-card'

  let icon = document.createElement('div')
  icon.className = 'file-icon'
  icon.textContent = (ext || 'file').toUpperCase().slice(0, 5)

  let title = document.createElement('div')
  title.className = 'file-name'
  title.textContent = name

  let meta = document.createElement('div')
  meta.className = 'file-meta'
  meta.textContent = [FILE_KIND[ext], typeof size === 'number' ? formatBytes(size) : null, 'preview not supported']
    .filter(Boolean)
    .join(' · ')

  let link = document.createElement('a')
  link.className = 'file-open'
  link.href = rawUrl(relativePath)
  link.target = '_blank'
  link.rel = 'noreferrer'
  link.textContent = 'Open ↗'

  card.append(icon, title, meta, link)
  wrap.append(card)
  content.replaceChildren(wrap)
}

/** Point the UI at a file the viewer can't display, then show the card. */
function showUnsupported(relativePath: string, size?: number) {
  setCurrentFilePath(relativePath)
  currentRaw = ''
  copyRawBtn.disabled = true
  printBtn.disabled = true
  content.scrollTop = 0
  renderUnsupported(relativePath, size)
}

// ---------------------------------------------------------------------------
// Click-to-enlarge (only for images already scaled down to fit)
// ---------------------------------------------------------------------------

let lightbox = document.querySelector<HTMLElement>('#lightbox')!
let lightboxImg = document.querySelector<HTMLImageElement>('#lightboxImg')!

/** True when the image is rendered smaller than its natural size. */
function isDownscaled(img: HTMLImageElement): boolean {
  return img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1
}

function refreshZoomable(img: HTMLImageElement) {
  img.classList.toggle('zoomable', img.complete && img.naturalWidth > 0 && isDownscaled(img))
}

function openLightbox(img: HTMLImageElement) {
  lightboxImg.src = img.currentSrc || img.src
  lightboxImg.alt = img.alt
  lightbox.hidden = false
}

function closeLightbox() {
  lightbox.hidden = true
  lightboxImg.removeAttribute('src')
}

content.addEventListener(
  'load',
  event => {
    if (event.target instanceof HTMLImageElement) refreshZoomable(event.target)
  },
  true,
)

content.addEventListener('click', event => {
  if (!(event.target instanceof HTMLImageElement)) return
  if (event.target.closest('a')) return // images inside links keep navigating
  if (!isDownscaled(event.target)) return // already 1:1 — nothing to reveal
  event.preventDefault()
  openLightbox(event.target)
})

window.addEventListener('resize', () => {
  content.querySelectorAll('img').forEach(img => refreshZoomable(img))
})

lightbox.addEventListener('click', event => {
  if (event.target === lightbox || (event.target as HTMLElement).id === 'lightboxClose') {
    closeLightbox()
  }
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !lightbox.hidden) closeLightbox()
})

// ---------------------------------------------------------------------------
// Loading files
// ---------------------------------------------------------------------------

async function loadFile(relativePath: string, options: { silent?: boolean } = {}) {
  try {
    let kind = mediaKind(relativePath)
    if (kind) {
      // Media is displayed straight from /raw; only stat it first so its bytes
      // are never read as text.
      let stat = await fetch(`/api/stat?path=${encodeURIComponent(relativePath)}`)
      if (!stat.ok) {
        let body = await stat.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${stat.status}`)
      }
      setCurrentFilePath(relativePath)
      currentRaw = ''
      copyRawBtn.disabled = true
      if (kind === 'audio' || kind === 'video') printBtn.disabled = true
      if (!options.silent) content.scrollTop = 0
      renderMedia(kind, relativePath)
      return
    }

    let response = await fetch(`/api/file?path=${encodeURIComponent(relativePath)}`)
    if (response.status === 413 || response.status === 415) {
      let body = await response.json().catch(() => ({}))
      showUnsupported(relativePath, typeof body.size === 'number' ? body.size : undefined)
      return
    }
    if (!response.ok) {
      let body = await response.json().catch(() => ({}))
      throw new Error(body.error ?? `HTTP ${response.status}`)
    }
    let data = (await response.json()) as { path: string; content: string }
    setCurrentFilePath(data.path)
    currentRaw = data.content
    copyRawBtn.disabled = false
    if (!options.silent) content.scrollTop = 0
    if (isMarkdownPath(data.path)) {
      await renderMarkdown(data.content, { trackChanges: options.silent === true })
    } else {
      renderPlainText(data.path, data.content)
    }
  } catch (error) {
    showToast(`Failed to open ${relativePath}: ${(error as Error).message}`)
    if (!currentFilePath) updateEmptyState()
  }
}

async function refreshCurrentFile() {
  if (!currentFilePath) return
  await loadFile(currentFilePath, { silent: true })
  showToast('Updated')
}

// ---------------------------------------------------------------------------
// Recent files (shared by the palette's "Recent" section)
// ---------------------------------------------------------------------------

const RECENT_FILES_KEY = 'md-live-viewer:recent-files'
const MAX_RECENT_FILES = 50

function getRecentFiles(): string[] {
  try {
    let raw = localStorage.getItem(RECENT_FILES_KEY)
    let list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rememberFile(file: string) {
  let list = getRecentFiles().filter(item => item !== file)
  list.unshift(file)
  localStorage.setItem(
    RECENT_FILES_KEY,
    JSON.stringify(list.slice(0, MAX_RECENT_FILES)),
  )
}

/** Drop a file from the recents list. */
function forgetFile(file: string) {
  let list = getRecentFiles().filter(item => item !== file)
  localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(list))
}

// ---------------------------------------------------------------------------
// File palette (Ctrl/Cmd + P)
// ---------------------------------------------------------------------------

function highlightMatch(file: string, query: string) {
  let trimmed = query.trim()
  let tokens = trimmed ? trimmed.split(/[\s/]+/).filter(Boolean) : []
  let basename = file.slice(file.lastIndexOf('/') + 1)
  let dir = file.slice(0, file.length - basename.length)

  // Cursor-like: filename first (strong), then the folder path (muted), left
  // to right. Truncation happens at the end, so the filename stays visible.
  let row = document.createElement('span')
  row.className = 'palette-path'

  let nameSpan = document.createElement('span')
  nameSpan.className = 'path-name'
  nameSpan.appendChild(highlightText(basename, tokens))
  row.appendChild(nameSpan)

  if (dir) {
    let dirSpan = document.createElement('span')
    dirSpan.className = 'path-dir'
    dirSpan.appendChild(highlightText(dir, tokens))
    row.appendChild(dirSpan)
  }

  return row
}

/**
 * Wrap each query token's match in <mark> within `text`.
 *
 * Matching is done per path **segment** (split on `/`) — like the search
 * itself — so a token never scatters letters across unrelated folders.
 * A segment is preferred when the token appears contiguously; otherwise a
 * subsequence match (for typos) is used, and only when the whole token fits.
 */
function highlightText(text: string, tokens: string[]) {
  let fragment = document.createDocumentFragment()
  if (tokens.length === 0) {
    fragment.append(text)
    return fragment
  }

  // Split into segments, remembering each segment's offset in `text`.
  let segments: { start: number; lower: string; length: number }[] = []
  let start = 0
  for (let index = 0; index <= text.length; index++) {
    if (index === text.length || text[index] === '/') {
      let value = text.slice(start, index)
      segments.push({ start, lower: value.toLowerCase(), length: value.length })
      start = index + 1
    }
  }

  let highlighted = new Set<number>()
  for (let token of tokens) {
    let lowerToken = token.toLowerCase()
    let best: { positions: number[]; segmentStart: number; score: number } | null = null

    for (let segment of segments) {
      let positions: number[] = []
      let score = 0
      let substringAt = segment.lower.indexOf(lowerToken)
      if (substringAt !== -1) {
        // Contiguous match — strongly preferred; shorter segments rank higher.
        for (let offset = 0; offset < lowerToken.length; offset++) {
          positions.push(substringAt + offset)
        }
        score = 10000 - segment.length
      } else {
        // Subsequence match within this one segment (typo tolerance).
        let tokenIndex = 0
        for (let index = 0; index < segment.length && tokenIndex < lowerToken.length; index++) {
          if (segment.lower[index] === lowerToken[tokenIndex]) {
            positions.push(index)
            tokenIndex++
          }
        }
        if (tokenIndex !== lowerToken.length) continue
        score = 1000 - segment.length
      }
      if (!best || score > best.score) {
        best = { positions, segmentStart: segment.start, score }
      }
    }

    if (!best) continue
    for (let position of best.positions) {
      highlighted.add(best.segmentStart + position)
    }
  }

  let previous = 0
  for (let index = 0; index <= text.length; index++) {
    if (!highlighted.has(index)) continue
    if (index > previous) fragment.append(text.slice(previous, index))
    let mark = document.createElement('mark')
    mark.textContent = text[index]
    fragment.append(mark)
    previous = index + 1
  }
  fragment.append(text.slice(previous))
  return fragment
}

function renderPaletteList() {
  paletteList.textContent = ''
  paletteItems = []
  let query = paletteInput.value.trim()

  let addHeader = (text: string) => {
    let header = document.createElement('li')
    header.className = 'palette-section'
    header.textContent = text
    paletteList.appendChild(header)
  }

  let addFile = (file: string, isRecent = false) => {
    let index = paletteResults.length
    paletteResults.push(file)
    let item = document.createElement('li')
    item.dataset.index = String(index)
    if (index === paletteActiveIndex) item.classList.add('active')
    item.appendChild(highlightMatch(file, query))

    // Recent rows get a remove button, placed *before* copy so the copy
    // button stays rightmost and aligns across Recent and All-files rows.
    if (isRecent) {
      let removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'palette-remove'
      // An SVG matches the weight of the other icons (a ✕ glyph is too thin).
      removeBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
      removeBtn.title = 'Remove from recent'
      removeBtn.onclick = event => {
        event.stopPropagation()
        forgetFile(file)
        renderPaletteList()
      }
      item.appendChild(removeBtn)
    }

    // Right-side button: copy the absolute path without opening the file.
    let copyBtn = document.createElement('button')
    copyBtn.type = 'button'
    copyBtn.className = 'palette-copy'
    copyBtn.innerHTML = COPY_ICON
    copyBtn.title = 'Copy absolute path (no open)'
    copyBtn.onclick = async event => {
      event.stopPropagation()
      let absolute = absolutePathFor(file)
      if (!absolute) return
      try {
        await navigator.clipboard.writeText(absolute)
        copyBtn.innerHTML = CHECK_ICON
        showToast('Copied path')
        setTimeout(() => (copyBtn.innerHTML = COPY_ICON), 1200)
      } catch {
        showToast('Clipboard blocked')
      }
    }
    item.appendChild(copyBtn)

    item.onclick = () => selectPaletteIndex(index)
    // Hovering moves the active selection too (like an editor quick-open).
    item.addEventListener('mouseenter', () => setActiveIndex(index))
    paletteList.appendChild(item)
    paletteItems.push(item)
  }

  // Reset results, then rebuild (recent section first when not searching).
  let recent = getRecentFiles().filter(file => paletteSource.includes(file))
  let rest = paletteSource.filter(file => !recent.includes(file))

  paletteResults = []
  if (query) {
    paletteSource.forEach(file => addFile(file))
  } else {
    if (recent.length > 0) {
      addHeader('Recent')
      recent.forEach(file => addFile(file, true))
      if (rest.length > 0) addHeader('All files')
    }
    // Cap the browse list; typing searches the full set.
    rest.slice(0, 300).forEach(file => addFile(file))
  }

  paletteEmpty.hidden = paletteResults.length > 0
  setActiveIndex(paletteActiveIndex)
}

/**
 * Move the active (keyboard-targeted) row.
 * `scroll: false` updates the highlight without moving the list — used when
 * the row is already visible (hover, or syncing from a user scroll).
 */
let suppressScrollSync = false
function setActiveIndex(index: number, options: { scroll?: boolean } = {}) {
  let { scroll = true } = options
  let count = paletteResults.length
  if (count === 0) {
    paletteActiveIndex = 0
    paletteItems.forEach(item => item.classList.remove('active'))
    return
  }
  paletteActiveIndex = ((index % count) + count) % count
  paletteItems.forEach((item, i) => {
    item.classList.toggle('active', i === paletteActiveIndex)
  })
  if (!scroll) return
  let active = paletteItems[paletteActiveIndex]
  if (!active) return
  // Ignore the scroll event our own scrollIntoView triggers.
  suppressScrollSync = true
  active.scrollIntoView({ block: 'nearest' })
  setTimeout(() => {
    suppressScrollSync = false
  }, 120)
}

/**
 * When the user scrolls the palette, move the active row to the first visible
 * one, so ↑/↓ continue from what's on screen instead of jumping to the top.
 */
function syncActiveToScroll() {
  if (suppressScrollSync || paletteItems.length === 0) return
  let listTop = paletteList.getBoundingClientRect().top
  let firstVisible = paletteItems.findIndex(item => {
    return item.getBoundingClientRect().bottom > listTop + 1
  })
  if (firstVisible === -1) firstVisible = paletteItems.length - 1
  if (firstVisible !== paletteActiveIndex) {
    setActiveIndex(firstVisible, { scroll: false })
  }
}

paletteList.addEventListener('scroll', () => {
  requestAnimationFrame(syncActiveToScroll)
})

async function runPaletteSearch() {
  let query = paletteInput.value
  let token = ++paletteSearchToken
  try {
    let response = await fetch(
      `/api/search?q=${encodeURIComponent(query)}&limit=50`,
    )
    let data = (await response.json()) as { files: string[] }
    if (token !== paletteSearchToken) return
    paletteSource = data.files
    paletteActiveIndex = 0
    renderPaletteList()
  } catch {
    // ignore transient errors
  }
}

async function openPalette() {
  if (allFiles.length === 0) {
    try {
      let response = await fetch('/api/files')
      let data = (await response.json()) as { files: string[] }
      allFiles = data.files
    } catch {
      showToast('Could not load file list')
    }
  }
  paletteInput.value = ''
  palette.showModal()
  paletteInput.focus()
  // Empty query: use the full file list so recents/tree are complete.
  paletteSource = allFiles.length > 0 ? allFiles : paletteSource
  paletteActiveIndex = 0
  if (paletteMode === 'tree') {
    if (currentFilePath) expandPathTo(currentFilePath)
    renderTree()
    paletteEmpty.hidden = paletteResults.length > 0
    setActiveIndex(paletteActiveIndex)
    return
  }
  renderPaletteList()
}

function selectPaletteIndex(index: number) {
  let file = paletteResults[index]
  if (!file) return
  palette.close()
  loadFile(file)
}

// ---------------------------------------------------------------------------
// Palette view mode: flat searchable list (default) or folder tree
// ---------------------------------------------------------------------------

function getSavedPaletteMode(): 'list' | 'tree' {
  return localStorage.getItem('md-live-viewer:palette-mode') === 'tree'
    ? 'tree'
    : 'list'
}

const LIST_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>'
const TREE_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5h3.5"/><path d="M4.5 3.5v9"/><path d="M6.5 6.5h7"/><path d="M6.5 9.5h7"/><path d="M6.5 12.5h7"/></svg>'
const COPY_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>'
const CHECK_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>'

function applyPaletteModeLabel() {
  let isList = paletteMode === 'list'
  // SVG icons avoid the font-metric drift of glyphs like ☰ vs 🌲.
  paletteModeIcon.innerHTML = isList ? LIST_ICON : TREE_ICON
  paletteModeLabel.textContent = isList ? 'List' : 'Tree'
}

function setPaletteMode(mode: 'list' | 'tree') {
  paletteMode = mode
  localStorage.setItem('md-live-viewer:palette-mode', mode)
  applyPaletteModeLabel()
  // Tree mode browses the full set; list mode searches.
  paletteSource = mode === 'tree' ? allFiles : paletteSource
  paletteActiveIndex = 0
  renderPalette()
}

/** Build the tree of folders/files from the flat relative-path list. */
function buildFileTree(files: string[]) {
  type Node = {
    name: string
    path: string
    children: Map<string, Node>
  }
  let root: Node = { name: '', path: '', children: new Map() }
  for (let file of files) {
    let parts = file.split('/')
    let current = root
    let prefix = ''
    for (let index = 0; index < parts.length; index++) {
      let name = parts[index]
      prefix = prefix ? `${prefix}/${name}` : name
      let isLeaf = index === parts.length - 1
      let existing = current.children.get(name)
      if (!existing) {
        existing = { name, path: prefix, children: new Map() }
        current.children.set(name, existing)
      }
      current = existing
      if (isLeaf) existing.children.clear()
    }
  }
  return root
}

function renderTree() {
  let root = buildFileTree(allFiles)

  let addNode = (
    node: { name: string; path: string; children: Map<string, any> },
    depth: number,
  ) => {
    let entries = [...node.children.values()].sort((a, b) => {
      let aDir = a.children.size > 0
      let bDir = b.children.size > 0
      // Folders first, then names.
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
    for (let child of entries) {
      let isDir = child.children.size > 0
      let expanded = expandedDirs.has(child.path)
      let item = document.createElement('li')
      let indent = '  '.repeat(depth)

      if (isDir) {
        item.className = 'tree-dir'
        item.textContent = `${indent}${expanded ? '▾' : '▸'} ${child.name}/`
        item.title = child.path
        item.onclick = () => {
          if (expanded) expandedDirs.delete(child.path)
          else expandedDirs.add(child.path)
          renderPalette()
        }
        paletteList.appendChild(item)
        if (expanded) addNode(child, depth + 1)
        continue
      }

      let index = paletteResults.length
      paletteResults.push(child.path)
      item.className = 'tree-file'
      if (child.path === currentFilePath) item.classList.add('tree-nearby')
      if (index === paletteActiveIndex) item.classList.add('active')
      let isNearby = currentFilePath
        ? child.path.slice(0, child.path.lastIndexOf('/') + 1) ===
          currentFilePath.slice(0, currentFilePath.lastIndexOf('/') + 1)
        : false
      if (isNearby) item.classList.add('tree-nearby')
      let arrow = document.createElement('span')
      arrow.className = 'tree-arrow'
      arrow.textContent = `${indent}  `
      item.appendChild(arrow)
      item.appendChild(document.createTextNode(child.name))
      item.dataset.index = String(index)
      item.onclick = () => selectPaletteIndex(index)
      item.addEventListener('mouseenter', () => setActiveIndex(index))
      paletteList.appendChild(item)
      paletteItems.push(item)
    }
  }

  addNode(root, 0)
}

/** Dispatch to the flat list or the tree renderer. */
function renderPalette() {
  let isTree = paletteMode === 'tree' && paletteInput.value.trim() === ''
  if (isTree) {
    paletteList.textContent = ''
    paletteItems = []
    paletteResults = []
    renderTree()
    paletteEmpty.hidden = paletteResults.length > 0
    setActiveIndex(paletteActiveIndex)
    return
  }
  renderPaletteList()
}

/** Expand the folder chain leading to `file` so it is visible in the tree. */
function expandPathTo(file: string) {
  let parts = file.split('/')
  parts.pop()
  let prefix = ''
  for (let part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part
    expandedDirs.add(prefix)
  }
}

openBtn.onclick = openPalette

/** Close a modal <dialog> when its backdrop is clicked (a click on the
 *  dialog element itself, outside its content box). */
function closeOnBackdropClick(dialog: HTMLDialogElement) {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close()
  })
}
closeOnBackdropClick(palette)

function runPaletteView() {
  if (paletteMode === 'tree' && paletteInput.value.trim() === '') {
    renderPalette()
    return
  }
  runPaletteSearch()
}

paletteInput.oninput = () => runPaletteView()
paletteInput.onkeydown = event => {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      setActiveIndex(paletteActiveIndex + 1)
      break
    case 'ArrowUp':
      event.preventDefault()
      setActiveIndex(paletteActiveIndex - 1)
      break
    case 'Enter':
      event.preventDefault()
      selectPaletteIndex(paletteActiveIndex)
      break
    case 'Escape':
      palette.close()
      break
  }
}

paletteModeBtn.onclick = () => {
  setPaletteMode(paletteMode === 'list' ? 'tree' : 'list')
  if (paletteMode === 'tree') {
    // Open the tree where the current file lives.
    if (currentFilePath) expandPathTo(currentFilePath)
    paletteInput.value = ''
  }
  renderPalette()
}

document.addEventListener('keydown', event => {
  let isOpenShortcut =
    (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'p'
  if (isOpenShortcut) {
    event.preventDefault()
    openPalette()
    return
  }
  if (palette.open) return
  if (event.key === 'r' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    refreshCurrentFile()
  }
})

// ---------------------------------------------------------------------------
// Live updates over Server-Sent Events
// ---------------------------------------------------------------------------

function connectEvents() {
  let source: EventSource | null = null
  let reconnectDelay = 1000
  let reconnectTimer: number | undefined

  function open() {
    clearTimeout(reconnectTimer)
    source = new EventSource('/api/events')

    source.addEventListener('ready', event => {
      statusNode.textContent = 'live'
      statusNode.className = 'live'
      reconnectDelay = 1000
      let data = JSON.parse((event as MessageEvent).data) as { mode: string }
      if (data.mode === 'poll') statusNode.textContent = 'live (polling)'
    })

    source.addEventListener('change', event => {
      let data = JSON.parse((event as MessageEvent).data) as {
        path: string | null
        type: string
      }
      if (data.type === 'reload') {
        // The served root changed; refresh the file list and clear the view.
        fetchFiles().then(files => {
          allFiles = files
        })
        return
      }
      if (!data.path) {
        refreshCurrentFile()
        return
      }
      if (data.path === currentFilePath) refreshCurrentFile()
    })

    source.onerror = () => {
      statusNode.textContent = 'reconnecting…'
      statusNode.className = 'offline'
      // The browser retries on its own for most failures, but a non-SSE
      // response (e.g. a 502 during a restart) permanently CLOSES the stream.
      // Recreate it ourselves in that case, with backoff.
      if (!source || source.readyState === EventSource.CLOSED) {
        source?.close()
        source = null
        clearTimeout(reconnectTimer)
        reconnectTimer = window.setTimeout(open, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 15000)
      }
    }
  }

  function ensureConnected() {
    if (!source || source.readyState === EventSource.CLOSED) {
      reconnectDelay = 1000
      open()
    }
  }

  open()
  // Recover promptly when the tab is refocused or the network returns.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ensureConnected()
  })
  window.addEventListener('online', ensureConnected)
  window.addEventListener('focus', ensureConnected)
}

// ---------------------------------------------------------------------------
// Copy the absolute path of the open file
// ---------------------------------------------------------------------------

function currentAbsolutePath(): string | null {
  if (!currentFilePath || !serverRoot) return null
  return absolutePathFor(currentFilePath)
}

/** Absolute path of any file (relative to the served root). */
function absolutePathFor(relativePath: string): string | null {
  if (!serverRoot) return null
  let separator = serverRoot.endsWith('/') ? '' : '/'
  return serverRoot + separator + relativePath
}

// Icons captured from the markup, so the transient "copied" tick restores the
// current icon instead of a hard-coded one that can drift from the HTML.
const COPY_RAW_ICON = copyRawBtn.textContent ?? ''
const COPY_PATH_ICON = copyPathBtn.textContent ?? ''

copyRawBtn.onclick = async () => {
  if (!currentRaw) return
  try {
    await navigator.clipboard.writeText(currentRaw)
    copyRawBtn.textContent = '✓'
    showToast('Copied raw Markdown')
    setTimeout(() => (copyRawBtn.textContent = COPY_RAW_ICON), 1500)
  } catch {
    showToast('Clipboard blocked')
  }
}

copyPathBtn.onclick = async () => {
  let path = currentAbsolutePath()
  if (!path) return
  try {
    await navigator.clipboard.writeText(path)
    copyPathBtn.textContent = '✓'
    showToast('Copied absolute path')
    setTimeout(() => (copyPathBtn.textContent = COPY_PATH_ICON), 1500)
  } catch {
    showToast('Clipboard blocked — path is in the title')
  }
}

// Clicking the header path opens the file picker (same as the Open button).
currentPath.title = 'Click to open the file picker (Ctrl/Cmd + P)'
currentPath.addEventListener('click', () => {
  openPalette()
})

// Save as PDF via the browser's print dialog. Browsers take the PDF's metadata
// title from `document.title`, so set it to the file name while printing.
printBtn.onclick = () => {
  let previousTitle = document.title
  if (currentFilePath) {
    let name = currentFilePath.slice(currentFilePath.lastIndexOf('/') + 1)
    document.title = name.replace(/\.(md|markdown|mdx|mdown|mkd)$/i, '')
  }
  let restore = () => {
    document.title = previousTitle
    window.removeEventListener('afterprint', restore)
  }
  window.addEventListener('afterprint', restore)
  window.print()
  // Fallback in case `afterprint` does not fire.
  setTimeout(restore, 5000)
}

// ---------------------------------------------------------------------------
// Theme toggle (system / light / dark)
// ---------------------------------------------------------------------------

type Theme = 'system' | 'light' | 'dark'
const THEME_ORDER: Theme[] = ['system', 'light', 'dark']
const THEME_ICON: Record<Theme, string> = {
  system: '🖥️',
  light: '☀️',
  dark: '🌙',
}

function getSavedTheme(): Theme {
  let value = localStorage.getItem('md-live-viewer:theme')
  return value === 'light' || value === 'dark' ? value : 'system'
}

function applyTheme(theme: Theme) {
  let root = document.documentElement
  if (theme === 'system') {
    delete root.dataset.theme
  } else {
    root.dataset.theme = theme
  }
  themeIcon.textContent = THEME_ICON[theme]
  themeBtn.title = `Theme: ${theme} (click to change)`
}

themeBtn.onclick = () => {
  let next = THEME_ORDER[(THEME_ORDER.indexOf(getSavedTheme()) + 1) % THEME_ORDER.length]
  localStorage.setItem('md-live-viewer:theme', next)
  applyTheme(next)
}

applyTheme(getSavedTheme())

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function fetchFiles(): Promise<string[]> {
  let response = await fetch('/api/files')
  let data = (await response.json()) as { root: string; files: string[] }
  serverRoot = data.root
  return data.files
}

/** Read the server's "recently changed" fade window (set by `--fade`). */
async function fetchConfig(): Promise<void> {
  try {
    let response = await fetch('/api/config')
    let data = (await response.json()) as { fadeMs?: number }
    if (typeof data.fadeMs === 'number') recentTtlMs = data.fadeMs
  } catch {
    // keep the built-in default fade window
  }
}

// ---------------------------------------------------------------------------
// Drag & drop a file to open it
// ---------------------------------------------------------------------------

function dataTransferHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function setupDropToOpen() {
  let overlay = document.querySelector<HTMLElement>('#dropOverlay')!
  let depth = 0

  window.addEventListener('dragenter', event => {
    if (!dataTransferHasFiles(event)) return
    event.preventDefault()
    depth++
    overlay.hidden = false
  })
  window.addEventListener('dragover', event => {
    if (!dataTransferHasFiles(event)) return
    event.preventDefault()
  })
  window.addEventListener('dragleave', event => {
    if (!dataTransferHasFiles(event)) return
    event.preventDefault()
    depth = Math.max(0, depth - 1)
    if (depth === 0) overlay.hidden = true
  })
  window.addEventListener('drop', event => {
    if (!dataTransferHasFiles(event)) return
    event.preventDefault()
    depth = 0
    overlay.hidden = true
    let file = event.dataTransfer?.files?.[0]
    if (file) void openDroppedFile(file)
  })
}

/**
 * Browsers hide a dropped file's OS path, so we recover it by matching the
 * dropped file's name against the served tree. That opens the real (watched)
 * file, with working links/images. A file from outside the served folder is
 * shown as a static, client-side preview (content only).
 */
async function openDroppedFile(file: File) {
  let matches = allFiles.filter(
    candidate => candidate === file.name || candidate.endsWith('/' + file.name),
  )

  if (matches.length === 1) {
    showToast(`Opened ${matches[0]}`)
    await loadFile(matches[0])
    return
  }

  if (matches.length > 1) {
    // Browsers hide the dropped file's path; disambiguate by metadata.
    // `file.lastModified` is the file's mtime, so size + mtime pin it down.
    let exact: string[] = []
    let sameSize: string[] = []
    for (let candidate of matches) {
      try {
        let response = await fetch(`/api/stat?path=${encodeURIComponent(candidate)}`)
        if (!response.ok) continue
        let stat = (await response.json()) as { size: number; mtimeMs: number }
        if (stat.size === file.size) {
          sameSize.push(candidate)
          if (Math.round(stat.mtimeMs) === file.lastModified) exact.push(candidate)
        }
      } catch {
        // ignore
      }
    }
    let winner = exact.length === 1 ? exact[0] : sameSize.length === 1 ? sameSize[0] : null
    if (winner) {
      showToast(`Opened ${winner}`)
      await loadFile(winner)
      return
    }
    // Still ambiguous — let the user pick.
    await openPalette()
    paletteInput.value = file.name
    await runPaletteSearch()
    showToast(`${matches.length} files named ${file.name} — pick one`)
    return
  }

  // Not in the served folder: static preview, no live updates.
  let text = await file.text()
  currentFilePath = null
  currentRaw = text
  currentPath.textContent = `📄 ${file.name} (dropped)`
  document.title = `${file.name} (dropped) - md-live-viewer`
  copyPathBtn.disabled = true
  copyRawBtn.disabled = false
  printBtn.disabled = false
  updateUrlHash()
  await renderMarkdown(text, { trackChanges: false })
  showToast('Preview only — not in the served folder')
}

async function boot() {
  paletteMode = getSavedPaletteMode()
  applyPaletteModeLabel()
  try {
    allFiles = await fetchFiles()
  } catch {
    // palette will retry
  }
  await fetchConfig()

  let requested =
    readStateFromHash().file ?? new URLSearchParams(location.search).get('file')
  let last = localStorage.getItem('md-live-viewer:last')
  let initial = requested ?? (last && allFiles.includes(last) ? last : null)
  if (!initial && allFiles.length > 0) {
    initial = allFiles.find(file => /readme\.md$/i.test(file)) ?? null
  }

  if (initial) {
    await loadFile(initial)
  } else {
    updateEmptyState()
  }

  // Follow hash changes (back/forward, or a pasted link in the same tab).
  window.addEventListener('hashchange', () => {
    let path = readStateFromHash().file
    if (path && path !== currentFilePath) loadFile(path)
  })

  setupDropToOpen()
  connectEvents()
}

boot()
