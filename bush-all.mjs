#!/usr/bin/env node

import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const makeJsonFile = await makeFile(
  'utf8',
  async raw => JSON.parse(raw),
  async parsed => JSON.stringify(parsed, null, 2)
)

export async function bushAll () {
  const text = await shell()`find . | grep bush.yaml | grep -v node_modules`

  const paths = text.trim().split(/[\r\n]/g)

  for await (const path of paths) {
    const pkg = makeJsonFile(path)

    const name = await pkg.get(({ name }) => name)

    console.log('---> ', name, `( ${path} )`)

    await shell({ cwd: dirname(path), stdio: 'inherit', shell: true })`bush`
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
      }
    }
  }
}

function shell (options) {
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

      const data = execSync(cmd, options)

      resolve(data?.toString('utf8'))
    })
  }
}
