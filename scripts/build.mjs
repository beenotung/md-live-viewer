import { build } from 'esbuild'
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

let rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let watch = process.argv.includes('--watch')
let dev = watch || process.argv.includes('--dev')

async function buildAll() {
  await rm(path.join(rootDir, 'dist'), { recursive: true, force: true })
  await mkdir(path.join(rootDir, 'dist'), { recursive: true })

  let serverOptions = {
    entryPoints: [path.join(rootDir, 'src/server/index.ts')],
    outfile: path.join(rootDir, 'dist/server.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    sourcemap: dev ? 'inline' : false,
  }

  let clientOptions = {
    entryPoints: [path.join(rootDir, 'src/client/main.ts')],
    outfile: path.join(rootDir, 'public/app.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2020',
    minify: !dev,
    sourcemap: dev,
  }

  if (watch) {
    let { context } = await import('esbuild')
    let serverCtx = await context(serverOptions)
    let clientCtx = await context(clientOptions)
    await serverCtx.watch()
    await clientCtx.watch()
    console.log('[build] watching for changes...')
  } else {
    await Promise.all([build(serverOptions), build(clientOptions)])
  }

  await copyKatex()
}

async function copyKatex() {
  let source = path.join(rootDir, 'node_modules/katex/dist')
  if (!existsSync(source)) {
    console.warn('[build] katex not installed; skipping katex assets')
    return
  }
  let target = path.join(rootDir, 'public/katex')
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await cp(path.join(source, 'katex.min.css'), path.join(target, 'katex.min.css'))
  await cp(path.join(source, 'fonts'), path.join(target, 'fonts'), {
    recursive: true,
  })
}

buildAll().catch(error => {
  console.error(error)
  process.exit(1)
})
