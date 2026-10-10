import fs from 'node:fs'
import path from 'node:path'

export type FileChangeEvent = {
  /** Relative path of the changed file, or null when unknown. */
  path: string | null
  type: 'change' | 'rename' | 'reload'
  at: number
}

export type Unsubscribe = () => void

/**
 * Watches a directory tree and notifies subscribers when files change.
 *
 * Uses recursive `fs.watch` for low-latency events, **plus** a periodic mtime
 * scan as a safety net. The scan matters because `fs.watch` can miss changes
 * after an atomic save (temp file + rename), which editors and agents often
 * do — the watched inode is replaced, so later in-place writes go unseen.
 *
 * Events are debounced so an editor that writes a file in several syscalls
 * still triggers a single notification.
 */
export class FileWatcher {
  private root: string
  private listeners = new Set<(event: FileChangeEvent) => void>()
  private watcher?: fs.FSWatcher
  private pollTimer?: NodeJS.Timeout
  private debounceTimer?: NodeJS.Timeout
  private pending = new Map<string, FileChangeEvent>()
  private mtimeCache = new Map<string, number>()
  private closed = false

  constructor(root: string) {
    this.root = root
  }

  get mode(): 'watch' | 'poll' {
    return this.watcher ? 'watch' : 'poll'
  }

  subscribe(listener: (event: FileChangeEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start() {
    if (this.watcher || this.pollTimer) return
    try {
      this.watcher = fs.watch(
        this.root,
        { recursive: true, persistent: true },
        (eventType, fileName) => {
          let relative = fileName ? fileName.toString().replaceAll('\\', '/') : null
          if (relative) this.touchCache(relative)
          this.queue({
            path: relative,
            type: eventType === 'rename' ? 'rename' : 'change',
            at: Date.now(),
          })
        },
      )
      this.watcher.on('error', () => this.fallbackToPolling())
      // Safety net while watching (slower interval than pure polling).
      this.startPolling(2500)
    } catch {
      this.fallbackToPolling()
    }
  }

  /** Watch failed — poll more aggressively. */
  private fallbackToPolling() {
    this.watcher?.close()
    this.watcher = undefined
    this.startPolling(1000)
  }

  private startPolling(intervalMs: number) {
    if (this.pollTimer || this.closed) return
    this.pollTimer = setInterval(() => this.poll(), intervalMs)
  }

  /** Update the mtime cache for one path so the poll does not re-report it. */
  private touchCache(relative: string) {
    try {
      let stats = fs.statSync(path.join(this.root, relative))
      if (stats.isFile()) this.mtimeCache.set(relative, stats.mtimeMs)
      else this.mtimeCache.delete(relative)
    } catch {
      this.mtimeCache.delete(relative)
    }
  }

  private poll() {
    let stack = ['']
    while (stack.length > 0) {
      let relativeDir = stack.pop()!
      let absoluteDir = relativeDir ? path.join(this.root, relativeDir) : this.root
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (let entry of entries) {
        if (entry.name.startsWith('.')) continue
        let relativePath = relativeDir
          ? `${relativeDir}/${entry.name}`
          : entry.name
        if (entry.isDirectory()) {
          stack.push(relativePath)
          continue
        }
        if (!entry.isFile()) continue
        let mtime: number
        try {
          mtime = fs.statSync(path.join(this.root, relativePath)).mtimeMs
        } catch {
          continue
        }
        if (this.mtimeCache.get(relativePath) === mtime) continue
        this.mtimeCache.set(relativePath, mtime)
        this.queue({ path: relativePath, type: 'change', at: Date.now() })
      }
    }
  }

  private queue(event: FileChangeEvent) {
    // Keep only the latest event per path, then flush once after a short delay.
    this.pending.set(event.path ?? '*', event)
    clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.flush(), 80)
  }

  private flush() {
    let events = [...this.pending.values()]
    this.pending.clear()
    for (let event of events) {
      for (let listener of this.listeners) {
        try {
          listener(event)
        } catch (error) {
          console.error('[watch] listener error:', error)
        }
      }
    }
  }

  close() {
    this.closed = true
    clearTimeout(this.debounceTimer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.watcher?.close()
    this.listeners.clear()
  }
}
