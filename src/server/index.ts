import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  isMarkdownFile,
  listFiles,
  resolveWithinRoot,
  searchFiles,
} from './files.ts'
import { FileWatcher } from './watch.ts'

// dist/server.js lives one level below the package root.
let packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

/** Files larger than this are not read as text (`/api/file` returns 413);
 *  media is served through `/raw` instead of being slurped into memory. */
const MAX_TEXT_FILE_BYTES = 25 * 1024 * 1024

/**
 * Heuristic for "not text": a NUL byte, or a high share of control bytes —
 * both common in binary formats but not in text. Bytes >= 0x80 are treated as
 * text, so Latin-1 / UTF-8 documents are not misread.
 */
function isBinary(buffer: Buffer): boolean {
  let sample = buffer.subarray(0, 8192)
  if (sample.length === 0) return false
  let control = 0
  for (let byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) control++
  }
  return control / sample.length > 0.1
}

/** Lower-case extension without the dot, or '' when there is none. */
function fileExtension(filePath: string): string {
  let slash = filePath.lastIndexOf('/')
  let dot = filePath.lastIndexOf('.')
  return dot > slash ? filePath.slice(dot + 1).toLowerCase() : ''
}

/** Document/archive/binary types we never read as text — shown as a card. */
const UNPREVIEWABLE_EXTENSIONS = new Set([
  'pptx', 'ppt', 'ppsx', 'pps', 'docx', 'doc', 'xlsx', 'xls', 'odt', 'ods', 'odp',
  'pages', 'numbers', 'key', 'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dmg', 'iso', 'apk', 'jar', 'class',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'psd', 'ai', 'db', 'sqlite',
])

export type CliOptions = {
  root: string
  host: string
  port: number
  open: boolean
  includeAllFiles: boolean
  /** How long the "recently changed" tint lasts, in ms (0 disables it). */
  fadeMs: number
}

/** Parse a duration like `300`, `90s`, `5m`, `1500ms`, or `off` (0) → ms. */
export function parseDuration(value: string): number {
  let trimmed = value.trim()
  if (/^(off|none|no|false)$/i.test(trimmed)) return 0
  let match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i.exec(trimmed)
  if (!match) throw new Error(`Invalid duration: ${value}`)
  let amount = Number(match[1])
  let unit = (match[2] ?? 's').toLowerCase()
  let factor = unit === 'ms' ? 1 : unit === 'm' ? 60000 : 1000
  return Math.round(amount * factor)
}

export function parseArgs(argv: string[], cwd = process.cwd()): CliOptions {
  let options: CliOptions = {
    root: cwd,
    host: 'localhost',
    port: 8137,
    open: true,
    includeAllFiles: false,
    fadeMs: 300000,
  }
  let positional: string[] = []
  for (let index = 0; index < argv.length; index++) {
    let arg = argv[index]
    // Support `--key=value` as well as `--key value` (long options only).
    let inlineValue: string | undefined
    if (arg.startsWith('--')) {
      let eq = arg.indexOf('=')
      if (eq !== -1) {
        inlineValue = arg.slice(eq + 1)
        arg = arg.slice(0, eq)
      }
    }
    let takeValue = () => (inlineValue !== undefined ? inlineValue : argv[++index])

    if (arg === '--port' || arg === '-p') {
      let value = takeValue()
      options.port = Number(value)
      if (!Number.isInteger(options.port) || options.port < 0) {
        throw new Error(`Invalid port: ${value}`)
      }
    } else if (arg === '--host') {
      options.host = takeValue()
    } else if (arg === '--open') {
      options.open = true
    } else if (arg === '--no-open') {
      options.open = false
    } else if (arg === '--all') {
      options.includeAllFiles = true
    } else if (arg === '--fade') {
      options.fadeMs = parseDuration(takeValue())
    } else if (arg === '--no-fade') {
      options.fadeMs = 0
    } else if (arg === '--help' || arg === '-h') {
      options.port = -1
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length > 0) {
    options.root = path.resolve(cwd, positional[0])
  }
  options.root = path.resolve(options.root)
  return options
}

const HELP = `md-live-viewer - live-updating markdown viewer

Usage:
  npx md-live-viewer [options] [dir]

Options and the optional [dir] may appear in any order.

Options:
  -p, --port <n>   Port to listen on (default 8137, use 0 for a random port)
      --host <h>   Host to bind (default localhost)
      --open       Open the browser (default)
      --no-open    Do not open the browser
      --all        List all files, not only markdown
      --fade <d>   How long "recently changed" stays tinted (default 5m;
                   e.g. 60s, 5m; 0 or --no-fade disables)
  -h, --help       Show this help

Examples:
  npx md-live-viewer                 # serve the current directory
  npx md-live-viewer ~/notes --open  # serve a specific folder
`

function sendJson(response: http.ServerResponse, status: number, body: unknown) {
  let payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(payload)
}

function serveStatic(response: http.ServerResponse, relativePath: string) {
  let publicDir = path.join(packageRoot, 'public')
  let filePath = resolveWithinRoot(publicDir, relativePath)
  let stats: fs.Stats
  try {
    stats = fs.statSync(filePath)
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html')
      stats = fs.statSync(filePath)
    }
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }
  let extension = path.extname(filePath).toLowerCase()
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': stats.size,
    'Cache-Control': 'no-cache',
  })
  fs.createReadStream(filePath).pipe(response)
}

export async function start(argv = process.argv.slice(2)): Promise<void> {
  let options = parseArgs(argv)
  if (options.port === -1) {
    process.stdout.write(HELP)
    return
  }
  let root = options.root
  let rootStats = fs.statSync(root)
  if (!rootStats.isDirectory()) {
    throw new Error(`Not a directory: ${root}`)
  }

  let fileCache: { at: number; files: string[] } = { at: 0, files: [] }
  function getFiles(force = false): string[] {
    let now = Date.now()
    if (force || now - fileCache.at > 5000) {
      fileCache = {
        at: now,
        files: listFiles(root, { includeAllFiles: options.includeAllFiles }),
      }
    }
    return fileCache.files
  }

  let watcher = new FileWatcher(root)
  let clients = new Set<http.ServerResponse>()
  let unsubscribeWatcher: () => void = () => {}

  function broadcast(event: { path: string | null; type: string; at: number }) {
    let payload = `event: change\ndata: ${JSON.stringify(event)}\n\n`
    for (let client of clients) client.write(payload)
  }

  /** (Re)subscribe the broadcast fan-out to the current watcher. */
  function subscribeWatcher() {
    unsubscribeWatcher()
    unsubscribeWatcher = watcher.subscribe(event => {
      if (event.path && !options.includeAllFiles && !isMarkdownFile(event.path)) {
        return
      }
      broadcast(event)
    })
  }

  let server = http.createServer((request, response) => {
    let url = new URL(request.url ?? '/', `http://${request.headers.host}`)

    if (url.pathname === '/api/config') {
      sendJson(response, 200, { fadeMs: options.fadeMs })
      return
    }

    if (url.pathname === '/api/files') {
      sendJson(response, 200, { root, files: getFiles(true) })
      return
    }

    if (url.pathname === '/api/search') {
      let query = url.searchParams.get('q') ?? ''
      let limit = Number(url.searchParams.get('limit') ?? '50') || 50
      sendJson(response, 200, {
        files: searchFiles(getFiles(), query, limit),
      })
      return
    }

    if (url.pathname === '/api/stat') {
      let relative = url.searchParams.get('path') ?? ''
      try {
        let absolute = resolveWithinRoot(root, relative)
        let stats = fs.statSync(absolute)
        sendJson(response, 200, {
          path: relative,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        })
      } catch (error) {
        let statusCode = (error as { statusCode?: number }).statusCode ?? 404
        sendJson(response, statusCode, { error: (error as Error).message })
      }
      return
    }

    if (url.pathname === '/api/file') {
      let relative = url.searchParams.get('path') ?? ''
      try {
        let absolute = resolveWithinRoot(root, relative)
        let stats = fs.statSync(absolute)
        if (UNPREVIEWABLE_EXTENSIONS.has(fileExtension(relative))) {
          // Known document/archive/binary types: card them without reading.
          sendJson(response, 415, { error: 'Not supported', size: stats.size })
          return
        }
        if (stats.size > MAX_TEXT_FILE_BYTES) {
          sendJson(response, 413, { error: 'Too large to show as text', size: stats.size })
          return
        }
        let buffer = fs.readFileSync(absolute)
        if (isBinary(buffer)) {
          // Binary (zip/office/executable): the client shows a "not supported" card.
          sendJson(response, 415, { error: 'Not supported', size: stats.size })
          return
        }
        sendJson(response, 200, {
          path: relative,
          content: buffer.toString('utf8'),
        })
      } catch (error) {
        let statusCode = (error as { statusCode?: number }).statusCode ?? 404
        sendJson(response, statusCode, { error: (error as Error).message })
      }
      return
    }

    if (url.pathname.startsWith('/raw/')) {
      let relative = decodeURIComponent(url.pathname.slice('/raw/'.length))
      try {
        let absolute = resolveWithinRoot(root, relative)
        let stats = fs.statSync(absolute)
        let extension = path.extname(absolute).toLowerCase()
        response.writeHead(200, {
          'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
          'Content-Length': stats.size,
          'Cache-Control': 'no-cache',
        })
        fs.createReadStream(absolute).pipe(response)
      } catch {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not found')
      }
      return
    }

    if (url.pathname === '/api/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      response.write(`retry: 3000\n\n`)
      response.write(`event: ready\ndata: ${JSON.stringify({ mode: watcher.mode })}\n\n`)

      clients.add(response)
      let keepAlive = setInterval(() => response.write(': ping\n\n'), 25000)
      request.on('close', () => {
        clearInterval(keepAlive)
        clients.delete(response)
      })
      return
    }

    let relative = url.pathname === '/' ? '/index.html' : url.pathname
    serveStatic(response, decodeURIComponent(relative))
  })

  watcher.start()
  subscribeWatcher()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => resolve())
  })

  let address = server.address()
  let port = typeof address === 'object' && address ? address.port : options.port
  let displayHost = options.host === '0.0.0.0' ? 'localhost' : options.host
  let url = `http://${displayHost}:${port}/`

  let fadeLabel =
    options.fadeMs <= 0
      ? 'off'
      : options.fadeMs % 60000 === 0
        ? `${options.fadeMs / 60000}m`
        : `${Math.round(options.fadeMs / 1000)}s`
  console.log(`\n  md-live-viewer`)
  console.log(`  root: ${root}`)
  console.log(`  url:  ${url}`)
  console.log(`  watch mode: ${watcher.mode}`)
  console.log(`  fade: ${fadeLabel} (--fade <dur>)\n`)

  if (options.open) {
    openBrowser({ url, host: options.host, port })
  }

  let shutdown = () => {
    unsubscribeWatcher()
    watcher.close()
    for (let client of clients) client.end()
    server.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

function openBrowser(options: { url: string; host: string; port: number }) {  let command: string
  let args: string[]
  if (process.platform === 'darwin') {
    command = 'open'
    args = [options.url]
  } else if (process.platform === 'win32') {
    command = 'cmd'
    args = ['/c', 'start', '', options.url]
  } else {
    command = 'xdg-open'
    args = [options.url]
  }
  try {
    let child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {
      // No browser available; the URL is printed for manual opening.
    })
    child.unref()
  } catch {
    // ignore
  }
}
