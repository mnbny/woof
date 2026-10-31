import type { ProjectDefinition } from './projects.ts'
import type { Resource, RootConfiguration, TokenValue } from './schema.ts'
import type { Zippable } from 'fflate'

import { strToU8, Unzip, UnzipInflate, unzipSync, zipSync } from 'fflate'
import { isAbsolute, win32 } from 'node:path'

import { parseConfigurationDocument } from './config.ts'
import { isMarkedResourceReference } from './resources.ts'

export const BUNDLE_LIMITS = {
  archiveBytes: 100 * 1024 * 1024,
  expandedBytes: 100 * 1024 * 1024,
  entries: 10_000,
} as const

export type BundleFile = { path: string; data: Uint8Array }
export type WoofBundle = {
  configuration: RootConfiguration
  projectName: string
  project: ProjectDefinition
  projectReference: string | undefined
  files: ReadonlyMap<string, Uint8Array>
}

export class BundleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid Woof bundle: ${message}`, options)
    this.name = 'BundleError'
  }
}

function archivePath(path: string) {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /^[A-Za-z]:/.test(path)
  )
    throw new BundleError(`entry ${JSON.stringify(path)} is not a safe root-relative path.`)
  const segments = path.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes(':') || /[. ]$/.test(segment))
      throw new BundleError(`entry ${JSON.stringify(path)} contains an unsafe destination component.`)
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))
      throw new BundleError(`entry ${JSON.stringify(path)} names a reserved device.`)
  }
  return path
}

function destinationKey(path: string) {
  return path.normalize('NFC').toLowerCase()
}

function indexedFiles(files: Iterable<BundleFile>) {
  const indexed = new Map<string, Uint8Array>()
  const destinations = new Set<string>()
  let expandedBytes = 0
  let entries = 0
  for (const file of files) {
    entries += 1
    if (entries > BUNDLE_LIMITS.entries)
      throw new BundleError(`the archive exceeds the ${BUNDLE_LIMITS.entries}-entry limit.`)
    const path = archivePath(file.path)
    const destination = destinationKey(path)
    if (destinations.has(destination))
      throw new BundleError(`multiple entries resolve to the destination ${JSON.stringify(path)}.`)
    destinations.add(destination)
    expandedBytes += file.data.byteLength
    if (expandedBytes > BUNDLE_LIMITS.expandedBytes)
      throw new BundleError(`expanded resources exceed the ${BUNDLE_LIMITS.expandedBytes}-byte limit.`)
    indexed.set(path, file.data)
  }
  return indexed
}

function resourcePath(reference: string) {
  if (reference.startsWith('<repo>/')) return undefined
  if (!reference.startsWith('<root>/'))
    throw new BundleError(`resource reference ${JSON.stringify(reference)} must begin with <root>/ or <repo>/.`)
  return archivePath(reference.slice('<root>/'.length))
}

function collectReferences(value: TokenValue, references: Set<string>, shared: boolean) {
  function add(reference: string) {
    if (shared && reference.startsWith('<repo>/'))
      throw new BundleError('shared root definitions cannot depend on repository resources.')
    references.add(reference)
  }

  if (typeof value === 'string') {
    if (isMarkedResourceReference(value)) add(value)
    return
  }
  if ('$type' in value || '$exec' in value) {
    const resource = value as Resource
    if (resource.$type === 'prompt') {
      if (isMarkedResourceReference(resource.$exec)) add(resource.$exec)
    } else {
      for (const exec of Array.isArray(resource.$exec) ? resource.$exec : [resource.$exec])
        if (isMarkedResourceReference(exec)) add(exec)
    }
    return
  }
  for (const child of Object.values(value)) collectReferences(child, references, shared)
}

function referencedResources(configuration: RootConfiguration, project: ProjectDefinition) {
  const references = new Set<string>()
  for (const [key, value] of Object.entries(configuration))
    if (key !== '$schemaVersion' && key !== '$projects') collectReferences(value as TokenValue, references, true)
  for (const [key, value] of Object.entries(project))
    if (key !== '$schemaVersion' && key !== '$metadata') collectReferences(value as TokenValue, references, false)
  return references
}

function configurationText(bytes: Uint8Array, path: string) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new BundleError(`configuration ${path} is not valid UTF-8.`, { cause: error })
  }
}

function validateBundle(files: ReadonlyMap<string, Uint8Array>): WoofBundle {
  const configurationBytes = files.get('woof.config.json')
  if (!configurationBytes) throw new BundleError('the root woof.config.json is missing.')
  const configuration = parseConfigurationDocument(
    configurationText(configurationBytes, 'woof.config.json'),
    'root',
    'bundle woof.config.json',
  )
  const projects = Object.entries(configuration.$projects ?? {})
  if (projects.length !== 1)
    throw new BundleError(`the root configuration must select exactly one project; found ${projects.length}.`)
  const [projectName, definition] = projects[0]!
  let project: ProjectDefinition
  let projectReference: string | undefined
  let projectPath: string | undefined
  if (typeof definition === 'string') {
    projectReference = definition
    projectPath = resourcePath(definition)
    if (!projectPath) throw new BundleError('a selected project configuration cannot be checkout-relative.')
    if (projectPath === 'woof.config.json')
      throw new BundleError('the selected project configuration cannot alias the root configuration.')
    const bytes = files.get(projectPath)
    if (!bytes) throw new BundleError(`selected project configuration ${projectPath} is missing.`)
    project = parseConfigurationDocument(configurationText(bytes, projectPath), 'project', `bundle ${projectPath}`)
  } else project = definition

  const required = new Set<string>()
  if (projectPath) required.add(projectPath)
  for (const reference of referencedResources(configuration, project)) {
    const path = resourcePath(reference)
    if (!path) continue
    if (path === 'woof.config.json') throw new BundleError('a payload cannot replace the root configuration.')
    if (!files.has(path)) throw new BundleError(`required resource ${path} is missing.`)
    required.add(path)
  }
  for (const path of files.keys())
    if (path !== 'woof.config.json' && !required.has(path))
      throw new BundleError(`entry ${path} is not required by the selected project or shared definitions.`)
  return { configuration, projectName, project, projectReference, files }
}

function decodeFailure(error: unknown): never {
  if (error instanceof BundleError) throw error
  throw new BundleError(`could not decode the ZIP archive: ${error instanceof Error ? error.message : String(error)}`, {
    cause: error,
  })
}

function validateDirectory(archive: Uint8Array) {
  const destinations = new Set<string>()
  let declaredBytes = 0
  try {
    unzipSync(archive, {
      filter(file) {
        archivePath(file.name)
        const destination = destinationKey(file.name)
        if (destinations.has(destination))
          throw new BundleError(`multiple entries resolve to the destination ${JSON.stringify(file.name)}.`)
        destinations.add(destination)
        if (destinations.size > BUNDLE_LIMITS.entries)
          throw new BundleError(`the archive exceeds the ${BUNDLE_LIMITS.entries}-entry limit.`)
        declaredBytes += file.originalSize
        if (declaredBytes > BUNDLE_LIMITS.expandedBytes)
          throw new BundleError(`expanded resources exceed the ${BUNDLE_LIMITS.expandedBytes}-byte limit.`)
        return false
      },
    })
  } catch (error) {
    decodeFailure(error)
  }
}

function unpack(archive: Uint8Array) {
  if (!archive.byteLength) throw new BundleError('the archive is empty.')
  if (archive.byteLength > BUNDLE_LIMITS.archiveBytes)
    throw new BundleError(`the archive exceeds the ${BUNDLE_LIMITS.archiveBytes}-byte input limit.`)
  validateDirectory(archive)
  const files: BundleFile[] = []
  const destinations = new Set<string>()
  let expandedBytes = 0
  let failure: unknown
  const unzip = new Unzip(file => {
    try {
      archivePath(file.name)
      const destination = destinationKey(file.name)
      if (destinations.has(destination))
        throw new BundleError(`multiple entries resolve to the destination ${JSON.stringify(file.name)}.`)
      destinations.add(destination)
      if (destinations.size > BUNDLE_LIMITS.entries)
        throw new BundleError(`the archive exceeds the ${BUNDLE_LIMITS.entries}-entry limit.`)
      const chunks: Uint8Array[] = []
      let length = 0
      file.ondata = (error, chunk, final) => {
        if (failure) return
        if (error) {
          failure = error
          return
        }
        length += chunk.byteLength
        expandedBytes += chunk.byteLength
        if (expandedBytes > BUNDLE_LIMITS.expandedBytes) {
          failure = new BundleError(`expanded resources exceed the ${BUNDLE_LIMITS.expandedBytes}-byte limit.`)
          file.terminate()
          return
        }
        chunks.push(chunk.slice())
        if (final) {
          const data = new Uint8Array(length)
          let offset = 0
          for (const part of chunks) {
            data.set(part, offset)
            offset += part.byteLength
          }
          files.push({ path: file.name, data })
        }
      }
      file.start()
    } catch (error) {
      failure = error
    }
  })
  unzip.register(UnzipInflate)
  try {
    unzip.push(archive, true)
  } catch (error) {
    failure = error
  }
  if (failure) decodeFailure(failure)
  return files
}

export function readBundleArchive(archive: Uint8Array) {
  return validateBundle(indexedFiles(unpack(archive)))
}

export function createBundleArchive(configuration: RootConfiguration, resources: Iterable<BundleFile>) {
  const files = indexedFiles([
    { path: 'woof.config.json', data: strToU8(`${JSON.stringify(configuration, null, 2)}\n`) },
    ...resources,
  ])
  validateBundle(files)
  const archive = zipSync(Object.fromEntries(files) as Zippable, { level: 6 })
  if (archive.byteLength > BUNDLE_LIMITS.archiveBytes)
    throw new BundleError(`the archive exceeds the ${BUNDLE_LIMITS.archiveBytes}-byte output limit.`)
  return archive
}
