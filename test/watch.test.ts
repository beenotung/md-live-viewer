import { strict as assert } from 'node:assert'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileWatcher } from '../src/server/watch.ts'

test('FileWatcher detects an in-place write after an atomic rename', async () => {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-watch-'))
  let file = path.join(root, 'doc.md')
  fs.writeFileSync(file, '# a\n')

  let watcher = new FileWatcher(root)
  let events: string[] = []
  watcher.subscribe(event => {
    if (event.path) events.push(event.path)
  })
  watcher.start()
  // let the watcher settle before touching the file
  await new Promise(resolve => setTimeout(resolve, 200))

  // Atomic save: write a temp file, then rename it over the target — this
  // replaces the inode and is what editors/agents often do.
  let temp = path.join(root, 'doc.md.tmp')
  fs.writeFileSync(temp, '# b\n')
  fs.renameSync(temp, file)
  await new Promise(resolve => setTimeout(resolve, 800))

  // Now an in-place append: fs.watch alone could miss this after the rename,
  // so the periodic safety-net poll must catch it.
  events.length = 0
  fs.appendFileSync(file, '\n## appended\n')
  await new Promise(resolve => setTimeout(resolve, 3300))

  watcher.close()
  assert.ok(
    events.includes('doc.md'),
    `expected a change for doc.md, got ${JSON.stringify(events)}`,
  )
})
