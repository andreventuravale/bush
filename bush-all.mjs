#!/usr/bin/env node

import { repeat } from 'lodash-es'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileExists } from './fileExists.mjs'

export async function bushAll () {
  const text = await shell()`find . | grep bush.yaml | grep -v node_modules`

  const paths = text.trim().split(/[\r\n]/g)

  for await (const path of paths) {
    if (!await fileExists(join(dirname(path), 'package.json'))) {
      continue
    }

    console.log(repeat('=', path.length + 4))
    console.log(`= ${path} =`)
    console.log(repeat('=', path.length + 4))

    await shell({ cwd: dirname(path), stdio: 'inherit', shell: true })`bush`
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
