import fs from 'node:fs'
import path from 'node:path'

export type FileChangeEvent = {
  /** Relative path of the changed file, or null when unknown (polling mode). */
  path: string | null
  type: 'change' | 'rename' | 'reload'
  at: number
}

export type Unsubscribe = () => void

/**
 * Watches a directory tree and notifies subscribers when files change.
 * Uses recursive `fs.watch` where the platform supports it, and falls back
 * to polling otherwise. Events are debounced so an editor that writes a file
 * in several syscalls still triggers a single notification.
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
          this.queue({
            path: relative,
            type: eventType === 'rename' ? 'rename' : 'change',
            at: Date.now(),
          })
        },
      )
      this.watcher.on('error', () => this.startPolling())
    } catch {
      this.startPolling()
    }
  }

  private startPolling() {
    if (this.pollTimer || this.closed) return
    this.watcher?.close()
    this.watcher = undefined
    this.pollTimer = setInterval(() => this.poll(), 1000)
  }

  private poll() {
    let changed: string[] = []
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
        let absolute = path.join(this.root, relativePath)
        let mtime: number
        try {
          mtime = fs.statSync(absolute).mtimeMs
        } catch {
          continue
        }
        if (this.mtimeCache.get(relativePath) !== mtime) {
          this.mtimeCache.set(relativePath, mtime)
          changed.push(relativePath)
        }
      }
    }
    if (changed.length > 0) {
      this.queue({ path: changed[changed.length - 1], type: 'change', at: Date.now() })
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
