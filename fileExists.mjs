import { stat } from 'node:fs/promises'

export async function fileExists (path) {
  try {
    await stat(path)

    return true
  } catch {
    return false
  }
}
