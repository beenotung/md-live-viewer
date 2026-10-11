import { strict as assert } from 'node:assert'
import test from 'node:test'
import { parseArgs } from '../src/server/index.ts'

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

test('parseArgs reports help via a negative port', () => {
  let options = parseArgs(['--help'], '/work')
  assert.equal(options.port, -1)
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
