#!/usr/bin/env node

import { get } from 'lodash-es'
import minimist from 'minimist'
import { spawn } from 'node:child_process'
import { promises as fsPromises } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { parse, stringify } from 'yaml'
import yn from 'yn'

const { readFile, stat, writeFile } = fsPromises

let { root: optRoot, config: optConfig, 'fill-gaps': optFillGaps } = minimist(process.argv)

if (!optRoot) {
  optRoot = '.'
}

const originalDir = process.cwd()

if (!optConfig) {
  optConfig = './bush.yaml'
}

const wpath = resolve(optRoot)

const configYaml = await readFile(optConfig, 'utf8')

const config = parse(configYaml, {
  reviver: (key, value) => value ?? ''
})

const jsonFile = await makeFile(
  'utf8',
  async raw => JSON.parse(raw),
  async parsed => JSON.stringify(parsed, null, 2)
)

const rootPkg = jsonFile(
  join(wpath, 'package.json')
)

await rootPkg.modify(async content => {
  content.name = config.name
})

await rootPkg.save()

await installDeps(config, rootPkg, config.root?.attributes?.references)

for await (const [wname, wnode] of Object.entries(config.workspaces)) {
  await shell({ cwd: wpath })`mkdir -p \\@${wname}`

  await visitNodes({ config, wname, wnode, packageNodes: wnode.tree, wpath, path: '' })
}

function shell ({ cwd = process.cwd() }) {
  return function (tpl = [], ...args) {
    return new Promise((resolve, reject) => {
      const tplParts = tpl.slice(0)
      const argParts = args.slice(0)
      const script = []

      while (tplParts.length > 0 || argParts.length > 0) {
        script.push(
          tplParts.shift() ?? '',
          argParts.shift() ?? ''
        )
      }

      const cmd = script.join('')

      console.log('$', cmd)

      const proc = spawn(cmd, { cwd, stdio: 'inherit', shell: true })

      let error

      proc.on('error', error_ => {
        error = error_
      })

      proc.on('close', code => {
        if (code === 0) {
          resolve()
        } else {
          reject(error)
        }
      })
    })
  }
}

async function installDeps (config, pkg, refs) {
  for await (
    const [
      ref,
      {
        'is-dev': isDevLocal = 'no',
        'save-peer': savePeer = 'no'
      } = {}
    ] of Object.entries(refs ?? {})
  ) {
    const isDevGlobal = config.references?.[ref]?.['is-dev']

    const isDev = isDevLocal ?? isDevGlobal ?? 'no'

    await shell({ cwd: pkg.dir })`${[
      config.manager,
      'add',
      `${ref}@${config.references?.[ref]?.version ?? 'latest'}`,
      yn(savePeer)
        ? '--save-peer'
        : (yn(isDev)
          ? '--save-dev'
          : '--save-prod')
    ]
      .filter(Boolean)
      .join(' ')}`

    await pkg.invalidate()
  }
}

async function visitNodes ({ config, wname, wnode, packageNodes, wpath, path }) {
  for await (const [palias, packageNode] of Object.entries(packageNodes ?? {})) {
    await visitNode({ config, wname, wnode, palias, packageNode, wpath, path })
  }
}

// Async function visitNodes({config, wname, wnode, packageNodes, wpath, path}) {
//   await Promise.all(
//     Object.entries(packageNodes ?? {}).map(async ([palias, packageNode]) => {
//       await visitNode({config, wname, wnode, palias, packageNode, wpath, path});
//     }),
//   );
// }

async function visitNode ({ config, wname, wnode, palias, packageNode, wpath, path }) {
  const apath = [path, palias].filter(Boolean).join('.')

  const packageName = wnode?.names[apath]

  const children = get(wnode?.tree, apath) ?? {}

  const refs = get(wnode?.references, apath) ?? {}

  try {
    if (packageName) {
      await shell({ cwd: join(wpath, `@${wname}`) })`mkdir -p ${packageName}`

      const pkgDir = join(wpath, `@${wname}`, packageName)

      const pkgPath = join(pkgDir, 'package.json')

      if (!await fileExists(pkgPath)) {
        const tmpl = JSON.parse(config.template)

        tmpl.name = `@${wname}/${packageName}`

        await writeFile(
          pkgPath,
          JSON.stringify(tmpl, null, 2),
          'utf8'
        )
      }

      const pkg = await jsonFile(pkgPath)

      await pkg.modify(async content => {
        content.name = `@${wname}/${packageName}`
      })

      console.group(`[${palias}]`, ':', pkg.name)

      const attributesList = Object
        .entries(wnode?.attributes ?? {})
        .filter(([pattern]) => apath && new RegExp(pattern, 'gim').test(apath))
        .map(([, attributes]) => attributes)

      for await (const attributes of attributesList) {
        await installDeps(config, pkg, attributes.references, apath)
      }

      for await (const [rpath] of Object.entries(refs)) {
        const rpackageName = wnode?.names[rpath]

        await pkg.modify(async content => {
          content.dependencies = content.dependencies ?? {}

          content.dependencies[`@${wname}/${rpackageName}`] = `${config.protocol}${`@${wname}/${rpackageName}`}`
        })

        console.log('->', rpath)
      }
    } else if (optFillGaps) {
      if (Object.entries(children).length === 0) {
        wnode.names[apath] = ''

        await writeFile(join(originalDir, optConfig), stringify(config, { nullStr: '' }), 'utf8')
      }
    } else {
      console.group(`[${palias}]`)
    }

    await visitNodes({ config, wname, wnode, packageNodes: packageNode, wpath, path: apath })
  } finally {
    console.groupEnd()
  }
}

async function makeFile (options, parse, serialize) {
  return path => {
    let content = null

    const getContent = async () => {
      if (content === null) {
        content = await parse(
          await readFile(path, options)
        )
      }

      return content
    }

    return {
      get dir () { return dirname(path) },

      get path () { return path },

      async invalidate () {
        content = null
      },

      async modify (action) {
        await action(
          await getContent()
        )
      },

      async save () {
        await writeFile(
          path,
          await serialize(
            await getContent()
          ),
          options
        )

        await this.invalidate()
      }
    }
  }
}

export async function fileExists (path) {
  try {
    await stat(path)

    return true
  } catch {
    return false
  }
}
