/**
 * @type {import('standard-version').Options.Updater}
 */
const workspacePackageVersionRegex = /(^\[workspace\.package\]\r?\n(?:(?!^\[).*\r?\n)*?^version\s*=\s*["'])([^"']+)(["'])/m

function readVersion(contents) {
  const match = contents.match(workspacePackageVersionRegex)

  if (!match) {
    throw new Error('Unable to find [workspace.package] version in Cargo.toml')
  }

  return match[2]
}

function writeVersion(contents, version) {
  if (!workspacePackageVersionRegex.test(contents)) {
    throw new Error('Unable to find [workspace.package] version in Cargo.toml')
  }

  return contents.replace(workspacePackageVersionRegex, (_match, prefix, _oldVersion, quote) => {
    return `${prefix}${version}${quote}`
  })
}

module.exports = {
  readVersion,
  writeVersion,
}
