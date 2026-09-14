/* eslint-disable @typescript-eslint/no-require-imports */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { readVersion: readCargoWorkspaceVersion } = require('./crates-version-updater.cjs')

const repositoryRoot = path.resolve(__dirname, '..')
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const sourcePackagePaths = [
  'package.json',
  'packages/protocol/package.json',
  'packages/runtime-worker/package.json',
  'packages/player/package.json',
  'crates/transmux-core/package.json',
]
const publishPackageNames = new Set(['@rivmux/protocol', '@rivmux/runtime-worker', 'rivmux'])

function parseArguments(argv) {
  const options = {
    artifacts: undefined,
    requireGenerated: false,
    tag: undefined,
    version: undefined,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--require-generated') {
      options.requireGenerated = true
      continue
    }

    if (argument === '--artifacts' || argument === '--tag' || argument === '--version') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a value.`)
      }
      options[argument.slice(2)] = value
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${argument}`)
  }

  return options
}

function readJson(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath)
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Missing JSON file: ${relativePath}`)
  }

  return JSON.parse(fs.readFileSync(absolutePath, 'utf8'))
}

function resolveExpectedVersion(options) {
  const version = options.version ?? (options.tag === undefined ? readJson('package.json').version : undefined)
  if (options.tag !== undefined) {
    if (!options.tag.startsWith('v')) {
      throw new Error(`Release tag must start with v: ${options.tag}`)
    }

    const tagVersion = options.tag.slice(1)
    if (!semverPattern.test(tagVersion)) {
      throw new Error(`Invalid release version in tag: ${options.tag}`)
    }
    if (version !== undefined && version !== tagVersion) {
      throw new Error(`Conflicting release versions: --version ${version} and --tag ${options.tag}`)
    }
    return tagVersion
  }

  if (version === undefined || !semverPattern.test(version)) {
    throw new Error(`Invalid release version: ${version ?? '<missing>'}`)
  }

  return version
}

function assertVersion(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} version ${actual ?? '<missing>'} does not match release version ${expected}.`)
  }
}

function validateSourceVersions(expectedVersion, requireGenerated) {
  for (const relativePath of sourcePackagePaths) {
    const packageJson = readJson(relativePath)
    assertVersion(relativePath, packageJson.version, expectedVersion)
  }

  const cargoVersion = readCargoWorkspaceVersion(fs.readFileSync(path.join(repositoryRoot, 'Cargo.toml'), 'utf8'))
  assertVersion('Cargo workspace', cargoVersion, expectedVersion)

  const generatedPath = 'crates/transmux-core/dist/package.json'
  if (requireGenerated) {
    assertVersion(generatedPath, readJson(generatedPath).version, expectedVersion)
  }
}

function readTarballPackageJson(tarballPath) {
  const contents = execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], { encoding: 'utf8' })
  return JSON.parse(contents)
}

function readTarballEntries(tarballPath) {
  return execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
}

function assertTarballEntry(entries, entry, packageName) {
  if (!entries.includes(entry)) {
    throw new Error(`${packageName} tarball is missing ${entry}.`)
  }
}

function validateTarballs(expectedVersion, artifactsDirectory) {
  const absoluteDirectory = path.resolve(artifactsDirectory)
  if (!fs.existsSync(absoluteDirectory)) {
    throw new Error(`Missing release artifacts directory: ${artifactsDirectory}`)
  }

  const tarballs = fs
    .readdirSync(absoluteDirectory)
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => path.join(absoluteDirectory, entry))
  const packages = new Map()

  for (const tarballPath of tarballs) {
    const packageJson = readTarballPackageJson(tarballPath)
    if (packages.has(packageJson.name)) {
      throw new Error(`Duplicate tarball for ${packageJson.name}.`)
    }
    packages.set(packageJson.name, { entries: readTarballEntries(tarballPath), packageJson, tarballPath })
  }

  if (packages.size !== publishPackageNames.size || [...publishPackageNames].some((name) => !packages.has(name))) {
    throw new Error(`Expected tarballs for ${[...publishPackageNames].join(', ')}; found ${[...packages.keys()].join(', ') || '<none>'}.`)
  }

  for (const packageName of publishPackageNames) {
    const artifact = packages.get(packageName)
    assertVersion(`${packageName} tarball`, artifact.packageJson.version, expectedVersion)

    const serializedPackageJson = JSON.stringify(artifact.packageJson)
    if (serializedPackageJson.includes('workspace:')) {
      throw new Error(`${packageName} tarball still contains workspace: dependency references.`)
    }

    if (packageName === 'rivmux') {
      assertTarballEntry(artifact.entries, 'package/dist/index.js', packageName)
      assertTarballEntry(artifact.entries, 'package/dist/index.d.ts', packageName)
      assertVersion('@rivmux/runtime-worker dependency', artifact.packageJson.dependencies?.['@rivmux/runtime-worker'], expectedVersion)
      assertVersion('@rivmux/protocol dependency', artifact.packageJson.dependencies?.['@rivmux/protocol'], expectedVersion)
    }

    if (packageName === '@rivmux/protocol') {
      assertTarballEntry(artifact.entries, 'package/dist/index.d.ts', packageName)
    }

    if (packageName === '@rivmux/runtime-worker') {
      assertTarballEntry(artifact.entries, 'package/dist/index.js', packageName)
      assertTarballEntry(artifact.entries, 'package/dist/rivmux-runtime-worker.js', packageName)
      assertTarballEntry(artifact.entries, 'package/dist/rivmux-transmux-core.wasm', packageName)
      assertVersion('@rivmux/protocol dependency', artifact.packageJson.dependencies?.['@rivmux/protocol'], expectedVersion)
      assertVersion('@rivmux/transmux-core devDependency', artifact.packageJson.devDependencies?.['@rivmux/transmux-core'], expectedVersion)
    }
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const expectedVersion = resolveExpectedVersion(options)
  validateSourceVersions(expectedVersion, options.requireGenerated)
  if (options.artifacts !== undefined) {
    validateTarballs(expectedVersion, options.artifacts)
  }

  process.stdout.write(`Release validation passed for ${expectedVersion}.\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`Release validation failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
