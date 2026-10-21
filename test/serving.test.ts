import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { negotiateEncoding } from '../src/server/index.ts'

// test/ lives one level below the package root that the server serves `public/` from.
let projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('negotiateEncoding prefers brotli when offered', () => {
  assert.equal(negotiateEncoding('gzip, deflate, br'), 'br')
  assert.equal(negotiateEncoding('gzip, deflate, br, zstd'), 'br')
  assert.equal(negotiateEncoding('BR'), 'br')
})

test('negotiateEncoding falls back to gzip for clients without brotli', () => {
  // Safari only advertises `br` over HTTPS, so plain-HTTP viewers land here.
  assert.equal(negotiateEncoding('gzip, deflate'), 'gzip')
  assert.equal(negotiateEncoding('gzip'), 'gzip')
})

test('negotiateEncoding honours refusals and wildcards', () => {
  assert.equal(negotiateEncoding('br;q=0, gzip'), 'gzip')
  assert.equal(negotiateEncoding('gzip;q=0, deflate'), null)
  assert.equal(negotiateEncoding('*'), 'br')
  assert.equal(negotiateEncoding('*;q=0'), null)
  assert.equal(negotiateEncoding('br;q=0.4, gzip;q=0.5'), 'br')
})

test('negotiateEncoding tolerates spacing, lists and missing headers', () => {
  assert.equal(negotiateEncoding(' br ; q=1.0 , gzip;q=0.8 '), 'br')
  assert.equal(negotiateEncoding(['gzip', 'br']), 'br')
  assert.equal(negotiateEncoding(undefined), null)
  assert.equal(negotiateEncoding(''), null)
  assert.equal(negotiateEncoding('identity'), null)
})

type RunningServer = {
  url: string
  close: () => Promise<void>
}

/**
 * Run the real CLI on an ephemeral port. `-e` is used so the test exercises
 * `src/` directly and does not depend on `dist/` having been built.
 */
async function startServer(root: string): Promise<RunningServer> {
  let child = spawn(
    process.execPath,
    [
      '-e',
      "import('./src/server/index.ts').then(module => module.start(process.argv.slice(1)))",
      root,
      '--port',
      '0',
      '--no-open',
    ],
    { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    output += chunk
  })

  let url = await new Promise<string>((resolve, reject) => {
    let timer = setTimeout(() => {
      reject(new Error(`server did not start within 15s: ${output}`))
    }, 15000)
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      let match = /url:\s+(http:\/\/\S+)/.exec(output)
      if (!match) return
      clearTimeout(timer)
      resolve(match[1])
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`server exited with ${code}: ${output}`))
    })
  })

  return {
    url,
    close: async () => {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await new Promise<void>(resolve => child.once('exit', () => resolve()))
    },
  }
}

type Response = {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

/** Raw HTTP, so the compressed bytes are visible (fetch would decode them). */
function request(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    let req = http.get(url, { headers }, response => {
      let chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        })
      })
    })
    req.on('error', reject)
  })
}

let bigText = '# big\n' + 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(2000)
let bigBuffer = Buffer.from(bigText)

/** Start a server over a temp folder with the given files, then clean up. */
async function withServer(
  files: Record<string, string | Buffer>,
  body: (context: { url: string; root: string }) => Promise<void>,
): Promise<void> {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-serve-'))
  for (let [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content)
  }
  let server = await startServer(root)
  try {
    await body({ url: server.url, root })
  } finally {
    await server.close()
  }
}

test('serving compresses with brotli when the client offers it', async () => {
  await withServer({ 'big.txt': bigText }, async ({ url }) => {
    let response = await request(`${url}raw/big.txt`, {
      'accept-encoding': 'gzip, deflate, br',
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-encoding'], 'br')
    assert.equal(response.headers['vary'], 'Accept-Encoding')
    assert.equal(Number(response.headers['content-length']), response.body.length)
    assert.ok(
      response.body.length < bigBuffer.length / 2,
      `expected under half the size, got ${response.body.length} of ${bigBuffer.length}`,
    )
    assert.equal(brotliDecompressSync(response.body).toString(), bigText)
  })
})

test('serving falls back to gzip when brotli is not offered', async () => {
  await withServer({ 'big.txt': bigText }, async ({ url }) => {
    let response = await request(`${url}raw/big.txt`, {
      'accept-encoding': 'gzip, deflate',
    })
    assert.equal(response.headers['content-encoding'], 'gzip')
    assert.equal(gunzipSync(response.body).toString(), bigText)
  })
})

test('serving sends identity when no encoding is accepted', async () => {
  await withServer({ 'big.txt': bigText }, async ({ url }) => {
    let response = await request(`${url}raw/big.txt`)
    assert.equal(response.headers['content-encoding'], undefined)
    assert.equal(Number(response.headers['content-length']), bigBuffer.length)
    assert.equal(response.body.length, bigBuffer.length)
    assert.equal(response.body.toString(), bigText)
  })
})

test('serving answers a matching If-None-Match with 304 and no body', async () => {
  await withServer({ 'big.txt': bigText }, async ({ url }) => {
    let first = await request(`${url}raw/big.txt`, { 'accept-encoding': 'br' })
    let etag = first.headers['etag']
    assert.ok(etag, 'expected an ETag on the first response')

    let second = await request(`${url}raw/big.txt`, {
      'accept-encoding': 'br',
      'if-none-match': etag,
    })
    assert.equal(second.status, 304)
    assert.equal(second.body.length, 0)
    assert.equal(second.headers['content-length'], undefined)
  })
})

test('serving keeps a separate validator per encoding', async () => {
  await withServer({ 'big.txt': bigText }, async ({ url }) => {
    let brotli = await request(`${url}raw/big.txt`, { 'accept-encoding': 'br' })
    let etag = brotli.headers['etag'] as string

    // A gzip-only client must not be told "not modified" by the br validator.
    let gzip = await request(`${url}raw/big.txt`, {
      'accept-encoding': 'gzip',
      'if-none-match': etag,
    })
    assert.equal(gzip.status, 200)
    assert.equal(gzip.headers['content-encoding'], 'gzip')
    assert.notEqual(gzip.headers['etag'], etag)
  })
})

test('serving skips small and already-compressed files', async () => {
  let png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  await withServer({ 'tiny.txt': 'hi', 'pixel.png': png }, async ({ url }) => {
    let tiny = await request(`${url}raw/tiny.txt`, { 'accept-encoding': 'br' })
    assert.equal(tiny.headers['content-encoding'], undefined)
    assert.equal(tiny.body.toString(), 'hi')

    let image = await request(`${url}raw/pixel.png`, { 'accept-encoding': 'br' })
    assert.equal(image.headers['content-encoding'], undefined)
    assert.equal(image.headers['content-type'], 'image/png')
    assert.ok(image.body.equals(png))
  })
})

test('serving recompresses after the file changes', async () => {
  await withServer({ 'big.txt': bigText }, async ({ url, root }) => {
    let first = await request(`${url}raw/big.txt`, { 'accept-encoding': 'br' })

    let changed = bigText.replace('lorem', 'LOREM')
    let filePath = path.join(root, 'big.txt')
    fs.writeFileSync(filePath, changed)
    // Guarantee a new mtime even on a coarse-grained clock.
    let future = new Date(Date.now() + 2000)
    fs.utimesSync(filePath, future, future)

    let second = await request(`${url}raw/big.txt`, { 'accept-encoding': 'br' })
    assert.notEqual(second.headers['etag'], first.headers['etag'])
    assert.equal(brotliDecompressSync(second.body).toString(), changed)
  })
})

test('serving compresses the bundled static assets too', async () => {
  await withServer({}, async ({ url }) => {
    let response = await request(url, { 'accept-encoding': 'br' })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-encoding'], 'br')
    let expected = fs.readFileSync(path.join(projectRoot, 'public/index.html'))
    assert.ok(
      brotliDecompressSync(response.body).equals(expected),
      'served body should decode to public/index.html',
    )
  })
})
