import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { userInfo, tmpdir, homedir } from 'os'
import { join, resolve } from 'path'
import { isInside } from './files.ts'

function getDir() {
  let dir = process.env.XDG_RUNTIME_DIR
  if (dir) {
    // this is per user already
    return join(dir)
  }
  // this is shared between users on linux, per-user on other platforms
  dir = tmpdir()
  if (process.platform === 'linux') {
    let user = getUser()
    if (user) {
      dir = join(dir, user)
    }
  }
  return dir
}
function getUser() {
  let user = ''

  try {
    user = userInfo().username
  } catch {
    // expected in containerized environments
  }

  try {
    user ||= process.geteuid?.().toString() || ''
  } catch {
    // expected in containerized environments
  }

  try {
    user ||= homedir().split('/').pop() || ''
  } catch {
    // expected in containerized environments
  }

  return user
}
let dir = join(getDir(), 'md-live-viewer')
let file = join(dir, 'registry')

export type Instance = {
  status: 'running' | 'stopped'
  port: number
  root: string
}

export async function scanInstances(): Promise<Instance[]> {
  let text = existsSync(file) ? readFileSync(file, 'utf-8') : ''
  let lines = text.split('\n')
  let instances: Instance[] = []
  for (let line of lines) {
    // skip empty lines
    line = line.trim()
    if (!line) continue

    let instance = JSON.parse(line) as Instance

    // skip invalid lines
    if (!instance.status || !instance.port || !instance.root) continue

    let index = instances.findIndex(i => i.port === instance.port)

    // check for stopped instance (from file)
    if (instance.status === 'stopped') {
      if (index !== -1) {
        instances.splice(index, 1)
      }
      continue
    }

    if (index === -1) {
      instances.push(instance)
    } else {
      instances[index] = instance
    }
  }

  // check for stopped instances (from process)
  for (let i = 0; i < instances.length; i++) {
    try {
      let instance = instances[i]
      let url = `http://localhost:${instance.port}/api/config`
      let res = await fetch(url)
      let json = await res.json()
      if (!json.root) throw new Error(`Invalid response from ${url}`)
      instance.root = json.root
    } catch (error) {
      instances.splice(i, 1)
      i--
    }
  }

  return instances
}

export function logInstance(instance: Instance) {
  mkdirSync(dir, { recursive: true })
  let line = JSON.stringify(instance) + '\n'
  appendFileSync(file, line)
}

/** The running viewer that serves `target`, preferring the most specific root.
 *  Optionally narrows the match to a specific `port`. */
export function findInstance(
  instances: Instance[],
  target: string,
  port?: number,
): Instance | null {
  let absolute = resolve(target)
  let best: Instance | null = null
  for (let instance of instances) {
    if (!isInside(instance.root, absolute)) continue
    if (port && instance.port !== port) continue
    if (!best || instance.root.length > best.root.length) best = instance
  }
  return best
}
