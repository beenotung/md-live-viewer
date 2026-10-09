import fs from 'node:fs'
import path from 'node:path'

/** Directories that are noise for a markdown viewer and can be huge. */
const IGNORED_DIRS = new Set([
  'node_modules',
  'bower_components',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  'venv',
  '__pycache__',
  '.venv',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.playwright-mcp',
])

export type ListOptions = {
  maxFiles?: number
  /** Also list non-markdown files (useful for a plain file browser). */
  includeAllFiles?: boolean
}

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.mdown', '.mkd'])

export function isMarkdownFile(filePath: string) {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/**
 * Recursively list files under `root` using an explicit stack (not recursion)
 * so a very deep tree cannot blow the call stack.
 */
export function listFiles(root: string, options: ListOptions = {}): string[] {
  let { maxFiles = 20000, includeAllFiles = false } = options
  let results: string[] = []
  let stack: string[] = ['']

  while (stack.length > 0 && results.length < maxFiles) {
    let relativeDir = stack.pop()!
    let absoluteDir = relativeDir ? path.join(root, relativeDir) : root
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (let entry of entries) {
      let name = entry.name
      // Skip dot-directories (.git, .cache, ...) but keep dot-files visible.
      if (entry.isDirectory() && name.startsWith('.')) continue
      if (entry.isDirectory() && IGNORED_DIRS.has(name)) continue
      if (entry.isSymbolicLink()) continue

      let relativePath = relativeDir ? `${relativeDir}/${name}` : name
      if (entry.isDirectory()) {
        stack.push(relativePath)
        continue
      }
      if (!entry.isFile()) continue
      if (!includeAllFiles && !isMarkdownFile(name)) continue
      results.push(relativePath)
      if (results.length >= maxFiles) break
    }
  }

  results.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return results
}

const SEPARATORS = new Set(['/', '\\', '-', '_', '.', ' ', '(', ')', '[', ']'])

function isBoundary(text: string, index: number) {
  if (index === 0) return true
  if (SEPARATORS.has(text[index - 1])) return true
  let prev = text[index - 1]
  let current = text[index]
  // camelCase boundary
  return prev >= 'a' && prev <= 'z' && current >= 'A' && current <= 'Z'
}

export type FuzzyMatch = {
  score: number
  /** Indices in the target string that were matched. */
  positions: number[]
}

/**
 * Subsequence fuzzy match with a small edit-distance allowance so typos still
 * match (e.g. "readm" or "radme" both find "README"). Based on the scoring
 * scheme used by fzf: reward consecutive and word-boundary matches, penalise
 * gaps and errors.
 */
export function fuzzyMatch(
  query: string,
  target: string,
  maxErrors = 1,
): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] }
  if (query.length > target.length + maxErrors) return null

  let queryLower = query.toLowerCase()
  let targetLower = target.toLowerCase()
  let queryLength = queryLower.length
  let targetLength = targetLower.length

  type State = { score: number; errors: number; positions: number[] }
  // best[i][e]: best state after matching `i` query chars, using `e` errors.
  let best: (State | null)[][] = Array.from({ length: queryLength + 1 }, () =>
    Array.from({ length: maxErrors + 1 }, () => null as State | null),
  )
  best[0][0] = { score: 0, errors: 0, positions: [] }

  for (let j = 0; j < targetLength; j++) {
    let targetChar = targetLower[j]
    // Iterate i from high to low so we only consume each target char once.
    for (let i = Math.min(queryLength, j + 1); i >= 1; i--) {
      for (let e = maxErrors; e >= 0; e--) {
        let exact = queryLower[i - 1] === targetChar
        if (!exact && e === 0) continue
        let neededErrors = exact ? 0 : 1
        let prevErrors = e - neededErrors
        if (prevErrors < 0) continue

        // Prefer matching right after a previous match (consecutive chars).
        let candidates: State[] = []
        for (let pe = prevErrors; pe >= 0; pe--) {
          let prev = best[i - 1][pe]
          if (!prev) continue
          let lastIndex = prev.positions[prev.positions.length - 1]
          let consecutive = i > 1 && lastIndex === j - 1
          let delta = exact ? 2 : -1
          if (isBoundary(target, j)) delta += 8
          if (consecutive) delta += 4
          delta -= prevErrors - pe
          candidates.push({
            score: prev.score + delta,
            errors: prev.errors + (e - pe),
            positions: prev.positions.concat(j),
          })
        }
        if (candidates.length === 0) continue
        candidates.sort((a, b) => b.score - a.score)
        let candidate = candidates[0]
        let current = best[i][e]
        if (!current || candidate.score > current.score) {
          best[i][e] = candidate
        }
      }
    }
  }

  let winner: State | null = null
  for (let e = 0; e <= maxErrors; e++) {
    let state = best[queryLength][e]
    if (!state) continue
    if (!winner || state.score > winner.score) winner = state
  }
  if (!winner) return null
  // Bigger penalty for longer targets so short, exact names rank first.
  let score = winner.score - Math.floor(targetLength / 8)
  return { score, positions: winner.positions }
}

export function searchFiles(files: string[], query: string, limit = 50): string[] {
  let trimmed = query.trim()
  if (!trimmed) return files.slice(0, limit)

  // Tokens are separated by whitespace or `/`, so a query can combine folder
  // and file words — either `docs config` or a pasted partial path like
  // `docs/config`. Each token must match, in any order.
  let tokens = trimmed.split(/[\s/]+/).filter(Boolean)
  let scored: { file: string; score: number }[] = []

  for (let file of files) {
    let total = 0
    let matchedAll = true

    for (let token of tokens) {
      let bestForToken = matchToken(token, file)
      if (bestForToken === null) {
        matchedAll = false
        break
      }
      total += bestForToken
    }

    if (!matchedAll) continue
    scored.push({ file, score: total })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.file.length - b.file.length
  })
  return scored.slice(0, limit).map(item => item.file)
}

/** Best score for one token across its swap-variants and path segments. */
function matchToken(token: string, file: string): number | null {
  let segments = file.split('/')
  let lastSegment = segments.length - 1
  let variants = queryVariants(token)
  let maxErrors = tokenMaxErrors(token)
  let best: number | null = null

  for (let index = 0; index < variants.length; index++) {
    let variant = variants[index]
    // Slight penalty for variants that required a character swap.
    let penalty = index === 0 ? 0 : 1

    // Match the token against a single path segment (folder or file name),
    // never across segment boundaries — that keeps folder words meaningful.
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      let match = fuzzyMatch(variant, segments[segmentIndex], maxErrors)
      if (!match) continue
      let isBasename = segmentIndex === lastSegment
      let score = match.score + (isBasename ? 20 : 0) - penalty
      if (best === null || score > best) best = score
    }
  }
  return best
}

/**
 * Only longer tokens get the 1-error allowance. For short tokens a single
 * substitution would let them match almost anything (e.g. `b` matching every
 * path), which defeats the folder+name filtering.
 */
function tokenMaxErrors(token: string): number {
  return token.length >= 6 ? 1 : 0
}

/**
 * The query plus variants with each pair of adjacent characters swapped.
 * This lets a transposition typo like "gudie" still find "guide.md", which
 * plain subsequence matching cannot do because the order is reversed.
 */
function queryVariants(query: string): string[] {
  let variants = [query]
  if (query.length > 24) return variants
  for (let index = 0; index + 1 < query.length; index++) {
    variants.push(
      query.slice(0, index) +
        query[index + 1] +
        query[index] +
        query.slice(index + 2),
    )
  }
  return variants
}

/** True when `child` is `parent` or lives inside it. */
function isInside(parent: string, child: string): boolean {
  let relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function realpathOr(filePath: string): string {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return filePath
  }
}

/**
 * Resolve a client-supplied relative path against `root` and reject anything
 * that escapes it. Both a lexical check and a **realpath** check are applied,
 * so a symlink inside the root that points outside is also rejected.
 */
export function resolveWithinRoot(root: string, relative: string): string {
  let normalized = relative.replaceAll('\\', '/').replace(/^\/+/, '')
  let lexical = path.resolve(root, normalized)
  if (!isInside(path.resolve(root), lexical)) {
    throw Object.assign(new Error('Path escapes the served root'), {
      statusCode: 403,
    })
  }
  let realTarget = realpathOr(lexical)
  if (!isInside(realpathOr(root), realTarget)) {
    throw Object.assign(new Error('Path escapes the served root'), {
      statusCode: 403,
    })
  }
  return realTarget
}
