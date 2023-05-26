#!/usr/bin/env node

const { bushRecursive } = require('./recursive.js')
const { dirname, join, resolve } = require('node:path')
const { fileExists } = require('./fileExists.js')
const { isEmpty, merge, unset } = require('lodash')
const { parse } = require('yaml')
const { readFile, writeFile } = require('node:fs/promises')
const { sortPackageJson } = require('sort-package-json')
const { spawn } = require('node:child_process')
const minimist = require('minimist')
const process = require('node:process')
const sortKeys = require('sort-keys')
const yn = require('yn')

const jsonFile = makeFile(
  'utf8',
  async raw => JSON.parse(raw),
  async parsed => JSON.stringify(parsed, null, 2)
)

let { recursive, root: optRoot, config: optConfig } = minimist(process.argv)

async function run () {
  if (yn(recursive)) {
    await bushRecursive()

    process.exit(0)
  }

  if (!optConfig) {
    optConfig = './bush.yaml'
  }

  const config = await loadConfig(optConfig)

  if (!optRoot) {
    optRoot = config['start-location'] ?? '.'
  }

  const rootPath = resolve(optRoot)

  const wpath = resolve(optRoot)

  process.chdir(optRoot)

  console.log(process.cwd())

  const rootPkg = jsonFile(
    join(wpath, 'package.json')
  )

  await rootPkg.modify(async content => {
    if (config.name) {
      content.name = unescapePackageName(config.name)
    }

    content.scripts = config.root?.scripts ?? {}

    if (isEmpty(content.scripts)) {
      unset(content, 'scripts')
    }
  })

  await rootPkg.modify(json => sortPackageJson(json))

  await rootPkg.save()

  await unsetDeps(rootPkg)

  await assignExternalDeps(config, rootPkg, config.root?.references?.external, { peer: false })

  for await (const [wname, wnode] of Object.entries(config.workspaces)) {
    await shell({ cwd: wpath })`mkdir -p ${wname}`

    await visitNodes({ config, wname, wnode, packageNodes: wnode.tree, wpath, path: '' })
  }

  await shell({ cwd: rootPath })`pnpm install`
}

run().catch(console.error)

async function loadConfig (path) {
  const configYaml = await readFile(path, 'utf8')

  let config = parse(configYaml, {
    reviver: (_, value) => value ?? ''
  })

  const mergeWith = config['merge-with']

  unset(config, 'merge-with')

  if (mergeWith) {
    const config2 = await Promise.all(
      mergeWith
        .trim()
        .split(',')
        .map(rel => join(dirname(path), rel.trim()))
        .map(p => loadConfig(p))
    )

    config = merge({}, ...config2, config)
  }

  return config
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

      const proc = spawn(cmd, { cwd, stdio: 'ignore', shell: true })

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

async function unsetDeps (pkg) {
  await pkg.modify(async content => {
    unset(content, 'dependencies')
    unset(content, 'devDependencies')
    unset(content, 'peerDependencies')
  })
}

async function assignExternalDeps (config, pkg, refs = {}, { peer = true } = {}) {
  for await (
    const [
      ref,
      {
        'is-dev': isDevLocal,
        'save-peer': savePeer = 'no',
        version: localVersion
      } = {}
    ] of Object.entries(refs ?? {})
  ) {
    const isDevGlobal = yn(config.packages?.[ref]?.['is-dev'])
    const isDev = yn(isDevLocal ?? isDevGlobal ?? 'no')
    const isPeer = yn(savePeer)
    const version = localVersion ?? config.packages?.[ref]?.version ?? 'latest'

    const prop = isDev || isPeer ? 'devDependencies' : 'dependencies'

    const name = unescapePackageName(ref)

    await pkg.modify(async content => {
      content[prop] = content[prop] ?? {}

      content[prop][name] = `${version}`

      if (peer && isPeer) {
        content.peerDependencies = content.peerDependencies ?? {}

        content.peerDependencies[name] = `${version}`
      }
    })
  }

  await pkg.modify(async content => {
    if (content.dependencies) { content.dependencies = sortKeys(content.dependencies) }
    if (content.devDependencies) { content.devDependencies = sortKeys(content.devDependencies) }
    if (content.peerDependencies) { content.peerDependencies = sortKeys(content.peerDependencies) }
  })

  await pkg.save()
}

async function assignLocalDeps (config, wnode, wname, apath, pkg) {
  const refsList = matchRefs(wnode, apath, 'workspace')

  for await (const refs of refsList) {
    for await (const [ref] of Object.entries(refs)) {
      const [rworkspace, rpath] = (
        ref.includes('@')
          ? ref
          : `${wname}@${ref}`
      ).split('@')

      const rwnode = config.workspaces[rworkspace]

      const rpkgName = getPkgName(config, rwnode, rpath)

      const depName = `@${getAttr(config, rwnode, 'scope')}/${rpkgName}`

      if (depName === await pkg.get(({ name }) => name)) {
        continue
      }

      await pkg.modify(async (content) => {
        content.dependencies = content.dependencies ?? {}

        content.dependencies[depName] = `${config.protocol}${config.protocol === 'workspace:' ? '*' : `@${getAttr(config, rwnode, 'scope')}/${rpkgName}`}`
      })

      console.log(wname, ':', '  >', rpath)
    }
  }
}

function getAttr (config, wnode, name, defaultValue) {
  return config.attributes?.[name] ?? wnode.attributes?.[name] ?? defaultValue
}

function unescapePackageName (name) {
  return name.replace('\\@', '@')
}

async function visitNodes ({ config, wname, wnode, packageNodes, wpath, path }) {
  for await (const [palias, packageNode] of Object.entries(packageNodes ?? {})) {
    await visitNode({ config, wname, wnode, palias, packageNode, wpath, path })
  }
}

async function visitNode ({ config, wname, wnode, palias, packageNode, wpath, path }) {
  const flat = yn(getAttr(config, wnode, 'flat'))

  const fspath = [path, palias].join('/').split('.').filter(Boolean).join('/')

  const apath = [path, palias].filter(Boolean).join('.')

  console.log(wname, ':', apath)

  const pkgName = getPkgName(config, wnode, apath)

  const isLeaf = !packageNode

  if (isLeaf) {
    const pkgDir = join(wpath, wname, flat ? pkgName : fspath)

    const pkgJsonPath = join(pkgDir, 'package.json')

    await shell({ cwd: join(wpath, wname) })`mkdir -p ${pkgDir}`

    if (!await fileExists(pkgJsonPath)) {
      const tmpl = JSON.parse(config.template)

      tmpl.name = `@${getAttr(config, wnode, 'scope')}/${pkgName}`

      await writeFile(
        pkgJsonPath,
        JSON.stringify(tmpl, null, 2),
        'utf8'
      )
    }

    const pkg = await jsonFile(pkgJsonPath)

    await unsetDeps(pkg)

    await pkg.modify(async content => {
      content.name = `@${getAttr(config, wnode, 'scope')}/${pkgName}`
    })

    await pkg.save()

    await assignLocalDeps(config, wnode, wname, apath, pkg)

    await pkg.save()

    const externalRefsList = matchRefs(wnode, apath, 'external')

    for await (const refs of externalRefsList) {
      await assignExternalDeps(config, pkg, refs, apath)
    }

    await pkg.modify(json => sortPackageJson(json))

    await pkg.save()
  }

  await visitNodes({ config, wname, wnode, packageNodes: packageNode, wpath, path: apath })
}

function matchRefs (wnode, apath, type) {
  return Object
    .entries(wnode?.references?.[type] ?? {})
    .filter(([nameOrPattern]) => {
      return (apath) && (
        (
          nameOrPattern.startsWith('/') &&
          nameOrPattern.endsWith('/') &&
          new RegExp(nameOrPattern.slice(1, -1), 'gim').test(apath)
        ) ||
        (nameOrPattern === apath)
      )
    })
    .map(([, refs]) => refs)
}

function getPkgName (config, wnode, name) {
  return [getAttr(config, wnode, 'prefix'), name].filter(Boolean).join('-').replace(/\./g, '-')
}

function makeFile (options, parse, serialize) {
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

      async get (action) {
        if (!action) {
          return await getContent()
        }

        return await action(
          await getContent()
        )
      },

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
