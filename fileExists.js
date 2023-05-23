const { stat } = require('node:fs/promises')

module.exports.fileExists = async function fileExists (path) {
  try {
    await stat(path)

    return true
  } catch {
    return false
  }
}
