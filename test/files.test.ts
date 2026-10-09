import { strict as assert } from 'node:assert'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  fuzzyMatch,
  isMarkdownFile,
  listFiles,
  resolveWithinRoot,
  searchFiles,
} from '../src/server/files.ts'

test('isMarkdownFile accepts markdown extensions', () => {
  assert.equal(isMarkdownFile('a.md'), true)
  assert.equal(isMarkdownFile('A.MARKDOWN'), true)
  assert.equal(isMarkdownFile('notes.mdx'), true)
  assert.equal(isMarkdownFile('a.txt'), false)
  assert.equal(isMarkdownFile('a.html'), false)
})

test('resolveWithinRoot rejects path traversal', () => {
  let root = '/tmp/root'
  assert.equal(resolveWithinRoot(root, 'a/b.md'), '/tmp/root/a/b.md')
  assert.equal(resolveWithinRoot(root, '/a.md'), '/tmp/root/a.md')
  assert.equal(resolveWithinRoot(root, './a.md'), '/tmp/root/a.md')
  assert.throws(() => resolveWithinRoot(root, '../secret.md'))
  assert.throws(() => resolveWithinRoot(root, 'a/../../secret.md'))
})

test('listFiles finds markdown files and skips ignored directories', () => {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-list-'))
  fs.mkdirSync(path.join(root, 'docs'))
  fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true })
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, 'README.md'), '# hi')
  fs.writeFileSync(path.join(root, 'docs/guide.md'), '# guide')
  fs.writeFileSync(path.join(root, 'docs/notes.txt'), 'text')
  fs.writeFileSync(path.join(root, 'node_modules/pkg/x.md'), '# x')
  fs.writeFileSync(path.join(root, '.git/y.md'), '# y')

  let files = listFiles(root)
  assert.deepEqual(files, ['README.md', 'docs/guide.md'])

  let all = listFiles(root, { includeAllFiles: true })
  assert.ok(all.includes('docs/notes.txt'))
  assert.ok(!all.some(file => file.includes('node_modules')))
})

test('fuzzyMatch matches exact and subsequence queries', () => {
  assert.ok(fuzzyMatch('readme', 'README.md'))
  assert.ok(fuzzyMatch('rdm', 'README.md'))
  assert.ok(fuzzyMatch('guide', 'docs/guide.md'))
  assert.equal(fuzzyMatch('zzzz', 'README.md'), null)
})

test('fuzzyMatch tolerates a deletion or substitution typo', () => {
  assert.ok(fuzzyMatch('readm', 'README.md'), 'missing trailing char')
  assert.ok(fuzzyMatch('readmeX', 'README.md'), 'substituted tail char')
  assert.ok(fuzzyMatch('rd', 'README.md'), 'missing middle chars')
})

test('searchFiles recovers from a transposition typo', () => {
  let files = ['docs/guide.md', 'src/main.ts.md']
  // "gudie" is a swapped "guide"; plain subsequence matching cannot fix it,
  // so searchFiles tries adjacent-swap variants.
  assert.deepEqual(searchFiles(files, 'gudie')[0], 'docs/guide.md')
})

test('searchFiles ranks an exact basename above a partial match', () => {
  let files = ['docs/notes.md', 'README.md', 'a/readme-old.md']
  let results = searchFiles(files, 'README.md')
  assert.equal(results[0], 'README.md')
})

test('searchFiles still returns results for a typo', () => {
  let files = ['docs/meeting-notes.md', 'src/readme.md']
  let results = searchFiles(files, 'meetng')
  assert.ok(results.includes('docs/meeting-notes.md'))
})

test('searchFiles matches multiple space-separated tokens (name + folder)', () => {
  let files = [
    'guides/setup/install-notes.md',
    'reference/install-notes.md',
    'guides/setup/other.md',
  ]
  let results = searchFiles(files, 'setup install')
  assert.deepEqual(results[0], 'guides/setup/install-notes.md')
  assert.ok(
    !results.includes('reference/install-notes.md'),
    'folder token must also match',
  )
  assert.ok(
    !results.includes('guides/setup/other.md'),
    'name token must also match',
  )
})

test('searchFiles disambiguates files with the same basename by folder', () => {
  let files = ['a/notes.md', 'b/notes.md']
  assert.deepEqual(searchFiles(files, 'notes b'), ['b/notes.md'])
  assert.deepEqual(searchFiles(files, 'notes a'), ['a/notes.md'])
})

test('searchFiles matches a pasted partial path with slashes', () => {
  let files = [
    'sessions/proj/03-vitals/outreach/polyu-nursing-kor/cover-email-proposal.md',
    'sessions/proj/03-vitals/other.md',
  ]
  // A pasted path fragment must match (the slash is not a literal char to find).
  assert.deepEqual(searchFiles(files, '03-vitals/outreach/cover-email'), [
    'sessions/proj/03-vitals/outreach/polyu-nursing-kor/cover-email-proposal.md',
  ])
  // Partial path that isn't contiguous in the real path still matches token-wise.
  assert.deepEqual(searchFiles(files, 'vitals cover-email'), [
    'sessions/proj/03-vitals/outreach/polyu-nursing-kor/cover-email-proposal.md',
  ])
})

test('searchFiles returns all files for an empty query', () => {
  let files = ['a.md', 'b.md', 'c.md']
  assert.deepEqual(searchFiles(files, ''), files)
  assert.deepEqual(searchFiles(files, '   ').length, 3)
})

test('resolveWithinRoot rejects a symlink that points outside the root', () => {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-link-'))
  let outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-out-'))
  let secret = path.join(outside, 'secret.md')
  fs.writeFileSync(secret, 'top secret')
  fs.symlinkSync(secret, path.join(root, 'link.md'))

  // A symlinked file inside the root must not be read through to the outside.
  assert.throws(() => resolveWithinRoot(root, 'link.md'))
})

test('resolveWithinRoot still allows normal files and nested dirs', () => {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-ok-'))
  fs.mkdirSync(path.join(root, 'sub'))
  fs.writeFileSync(path.join(root, 'a.md'), '# a')
  fs.writeFileSync(path.join(root, 'sub/b.md'), '# b')

  assert.equal(resolveWithinRoot(root, 'a.md'), path.join(fs.realpathSync(root), 'a.md'))
  assert.equal(
    resolveWithinRoot(root, 'sub/b.md'),
    path.join(fs.realpathSync(root), 'sub/b.md'),
  )
})
