import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deepLink, parseArgs, resolveTarget } from '../src/server/index.ts'
import type { Instance } from '../src/server/instance.ts'

test('parseArgs defaults to the given cwd', () => {
  let options = parseArgs([], '/work/notes')
  assert.equal(options.root, '/work/notes')
  assert.equal(options.port, 8137)
  assert.equal(options.host, 'localhost')
  assert.equal(options.open, true)
})

test('parseArgs accepts a directory argument and options', () => {
  let options = parseArgs(['docs', '--port', '9000', '--no-open', '--host', '0.0.0.0'], '/work')
  assert.equal(options.root, '/work/docs')
  assert.equal(options.port, 9000)
  assert.equal(options.open, false)
  assert.equal(options.host, '0.0.0.0')
})

test('parseArgs resolves relative directories against cwd', () => {
  let options = parseArgs(['../notes'], '/work/project')
  assert.equal(options.root, '/work/notes')
})

test('parseArgs accepts --key=value for long options', () => {
  let options = parseArgs(['--port=9001', '--host=0.0.0.0', '--all'], '/work')
  assert.equal(options.port, 9001)
  assert.equal(options.host, '0.0.0.0')
  assert.equal(options.includeAllFiles, true)
})

test('parseArgs accepts short aliases for host, all, open and no-open', () => {
  assert.equal(parseArgs(['-H', '0.0.0.0'], '/work').host, '0.0.0.0')
  assert.equal(parseArgs(['-a'], '/work').includeAllFiles, true)
  assert.equal(parseArgs(['-o'], '/work').open, true)
  assert.equal(parseArgs(['-n'], '/work').open, false)
  assert.equal(parseArgs(['-h'], '/work').flags.show_help, true)
})

test('resolveTarget serves a folder or the parent of a file', () => {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-view-target-'))
  let file = path.join(dir, 'a.md')
  fs.writeFileSync(file, '# a\n')
  try {
    assert.deepEqual(resolveTarget(dir), { root: dir, file: null })
    assert.deepEqual(resolveTarget(file), { root: dir, file })
    assert.throws(() => resolveTarget(path.join(dir, 'missing.md')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deepLink builds a file fragment', () => {
  let instance: Instance = { status: 'running', port: 8100, root: '/work' }
  assert.equal(
    deepLink(instance, '/work/a/b.md'),
    'http://localhost:8100/#file=a/b.md',
  )
  assert.equal(
    deepLink(instance, '/work/a b.md'),
    'http://localhost:8100/#file=a%20b.md',
  )
})

test('parseArgs reports help, version and list via flags', () => {
  assert.equal(parseArgs(['--help'], '/work').flags.show_help, true)
  assert.equal(parseArgs(['-h'], '/work').flags.show_help, true)
  assert.equal(parseArgs(['--version'], '/work').flags.show_version, true)
  assert.equal(parseArgs(['-v'], '/work').flags.show_version, true)
  assert.equal(parseArgs(['--list'], '/work').flags.list_instances, true)
  assert.equal(parseArgs(['-l'], '/work').flags.list_instances, true)
  assert.equal(parseArgs([], '/work').flags.show_help, false)
})

test('parseArgs reads --detach as a serve mode, not a flag', () => {
  assert.equal(parseArgs(['--detach'], '/work').detach, true)
  assert.equal(parseArgs(['-d'], '/work').detach, true)
  assert.equal(parseArgs([], '/work').detach, false)
  assert.equal(parseArgs(['--detach'], '/work').flags.show_help, false)
})

test('parseArgs resolves --where against cwd', () => {
  assert.equal(parseArgs(['--where', 'docs/a.md'], '/work').where, '/work/docs/a.md')
  assert.equal(
    parseArgs(['--where=../notes/b.md'], '/work/project').where,
    '/work/notes/b.md',
  )
  assert.equal(parseArgs([], '/work').where, null)
  assert.throws(() => parseArgs(['--where'], '/work'))
})

test('parseArgs rejects an invalid port and unknown flags', () => {
  assert.throws(() => parseArgs(['--port', 'abc'], '/work'))
  assert.throws(() => parseArgs(['--nope'], '/work'))
})

test('parseArgs parses --fade durations (default 5m)', () => {
  assert.equal(parseArgs([], '/work').fadeMs, 300000)
  assert.equal(parseArgs(['--fade', '60'], '/work').fadeMs, 60000)
  assert.equal(parseArgs(['--fade', '90s'], '/work').fadeMs, 90000)
  assert.equal(parseArgs(['--fade=2m'], '/work').fadeMs, 120000)
  assert.equal(parseArgs(['--fade', '1500ms'], '/work').fadeMs, 1500)
  assert.equal(parseArgs(['--fade', '0'], '/work').fadeMs, 0)
  assert.equal(parseArgs(['--fade', 'off'], '/work').fadeMs, 0)
  assert.equal(parseArgs(['--no-fade'], '/work').fadeMs, 0)
  assert.throws(() => parseArgs(['--fade', 'soon'], '/work'))
})
