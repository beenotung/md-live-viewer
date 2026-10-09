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
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

export type CliOptions = {
  root: string
  host: string
  port: number
  open: boolean
  includeAllFiles: boolean
}

export function parseArgs(argv: string[], cwd = process.cwd()): CliOptions {
  let options: CliOptions = {
    root: cwd,
    host: 'localhost',
    port: 8137,
    open: true,
    includeAllFiles: false,
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

    if (url.pathname === '/api/file') {
      let relative = url.searchParams.get('path') ?? ''
      try {
        let absolute = resolveWithinRoot(root, relative)
        let content = fs.readFileSync(absolute, 'utf8')
        sendJson(response, 200, {
          path: relative,
          content,
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

  console.log(`\n  md-live-viewer`)
  console.log(`  root: ${root}`)
  console.log(`  url:  ${url}`)
  console.log(`  watch mode: ${watcher.mode}\n`)

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
