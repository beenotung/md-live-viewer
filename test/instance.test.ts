import { strict as assert } from 'node:assert'
import test from 'node:test'
import { findInstance } from '../src/server/instance.ts'
import type { Instance } from '../src/server/instance.ts'

function instance(port: number, root: string): Instance {
  return { status: 'running', port, root }
}

test('findInstance prefers the most specific root', () => {
  let instances = [instance(8137, '/work'), instance(8100, '/work/notes')]
  assert.equal(findInstance(instances, '/work/notes/a.md')?.port, 8100)
  assert.equal(findInstance(instances, '/work/other/b.md')?.port, 8137)
  assert.equal(findInstance(instances, '/elsewhere/c.md'), null)
})

test('findInstance does not match a shared path prefix', () => {
  let instances = [instance(8137, '/work/notes')]
  assert.equal(findInstance(instances, '/work/notes2/a.md'), null)
})
