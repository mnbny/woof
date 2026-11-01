import type { ProjectDefinition } from './projects.ts'
import type { Resource, RootConfiguration, TokenValue } from './schema.ts'
import type { Zippable } from 'fflate'

import { strToU8, Unzip, UnzipInflate, unzipSync, zipSync } from 'fflate'
import { isAbsolute } from 'node:path'
import { crc32 } from 'node:zlib'

import { parseConfigurationDocument } from './config.ts'
import { isMarkedResourceReference } from './resources.ts'

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
    super(`Invalid woof bundle: ${message}`, options)
    this.name = 'BundleError'
  }
}

function archivePath(path: string) {
  if (
    !path ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split('/').some(segment => !segment || segment === '.' || segment === '..')
  )
    throw new BundleError(`entry ${JSON.stringify(path)} is not a safe root-relative path.`)
  return path
}

function indexedFiles(files: Iterable<BundleFile>) {
  const indexed = new Map<string, Uint8Array>()
  for (const file of files) {
    const path = archivePath(file.path)
    if (indexed.has(path)) throw new BundleError(`multiple entries use the destination ${JSON.stringify(path)}.`)
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

export function referencedResources(configuration: RootConfiguration, ...projects: ProjectDefinition[]) {
  const references = new Set<string>()
  for (const [key, value] of Object.entries(configuration))
    if (key !== '$schemaVersion' && key !== '$projects') collectReferences(value as TokenValue, references, true)
  for (const project of projects)
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
    required.add(path)
  }
  const selected = new Map([...files].filter(([path]) => path === 'woof.config.json' || required.has(path)))
  return { configuration, projectName, project, projectReference, files: selected }
}

function decodeFailure(error: unknown): never {
  if (error instanceof BundleError) throw error
  throw new BundleError(`could not decode the ZIP archive: ${error instanceof Error ? error.message : String(error)}`, {
    cause: error,
  })
}

type DirectoryEntry = {
  name: string
  compression: number
  compressedSize: number
  crc: number
  size: number
  special: boolean
}

function centralDirectory(archive: Uint8Array) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  let end = -1
  for (let offset = archive.byteLength - 22; offset >= Math.max(0, archive.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue
    const comment = view.getUint16(offset + 20, true)
    if (offset + 22 + comment === archive.byteLength) {
      end = offset
      break
    }
  }
  if (end < 0) throw new BundleError('the central-directory end record is missing or truncated.')
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== view.getUint16(end + 10, true)
  )
    throw new BundleError('multi-disk archives are not supported.')
  const count = view.getUint16(end + 10, true)
  const size = view.getUint32(end + 12, true)
  const offset = view.getUint32(end + 16, true)
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff)
    throw new BundleError('ZIP64 directory metadata is not supported.')
  if (offset + size !== end) throw new BundleError('the central-directory range is inconsistent.')
  const entries: Omit<DirectoryEntry, 'name'>[] = []
  let cursor = offset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
      throw new BundleError(`central-directory entry ${index + 1} is missing or malformed.`)
    const external = view.getUint32(cursor + 38, true)
    const fileType = (external >>> 16) & 0o170000
    const localOffset = view.getUint32(cursor + 42, true)
    if (localOffset === 0xffffffff || localOffset >= offset)
      throw new BundleError(`central-directory entry ${index + 1} has an invalid local offset.`)
    entries.push({
      compression: view.getUint16(cursor + 10, true),
      compressedSize: view.getUint32(cursor + 20, true),
      crc: view.getUint32(cursor + 16, true),
      size: view.getUint32(cursor + 24, true),
      special: fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000,
    })
    if (entries.at(-1)!.compressedSize === 0xffffffff || entries.at(-1)!.size === 0xffffffff)
      throw new BundleError('ZIP64 entry sizes are not supported.')
    cursor +=
      46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true)
  }
  if (cursor !== end) throw new BundleError('the central-directory entries do not fill the declared range.')
  return entries
}

function validateDirectory(archive: Uint8Array) {
  const destinations = new Set<string>()
  try {
    const expected = centralDirectory(archive)
    const entries: DirectoryEntry[] = []
    unzipSync(archive, {
      filter(file) {
        const entry = expected[entries.length]
        if (
          !entry ||
          entry.size !== file.originalSize ||
          entry.compressedSize !== file.size ||
          entry.compression !== file.compression
        )
          throw new BundleError(`central-directory metadata is inconsistent for ${file.name}.`)
        archivePath(file.name.endsWith('/') ? file.name.slice(0, -1) : file.name)
        const destination = file.name
        if (destinations.has(destination))
          throw new BundleError(`multiple entries resolve to the destination ${JSON.stringify(file.name)}.`)
        destinations.add(destination)
        entries.push({ ...entry, name: file.name })
        return false
      },
    })
    if (entries.length !== expected.length) throw new BundleError('the central-directory entry count is inconsistent.')
    return entries
  } catch (error) {
    decodeFailure(error)
  }
}

function unpack(archive: Uint8Array) {
  if (!archive.byteLength) throw new BundleError('the archive is empty.')
  const expected = validateDirectory(archive)
  const files: BundleFile[] = []
  const special = new Set<string>()
  const destinations = new Set<string>()
  let failure: unknown
  const unzip = new Unzip(file => {
    try {
      const entry = expected[files.length]
      if (!entry) throw new BundleError(`local entry ${file.name} is absent from the central directory.`)
      if (
        file.name !== entry.name ||
        file.compression !== entry.compression ||
        (file.originalSize !== undefined && file.originalSize !== entry.size) ||
        (file.size !== undefined && file.size !== entry.compressedSize)
      )
        throw new BundleError(`local and central-directory metadata disagree for ${file.name}.`)
      archivePath(file.name.endsWith('/') ? file.name.slice(0, -1) : file.name)
      const destination = file.name
      if (destinations.has(destination))
        throw new BundleError(`multiple entries resolve to the destination ${JSON.stringify(file.name)}.`)
      destinations.add(destination)
      if (entry.special) special.add(file.name)
      const chunks: Uint8Array[] = []
      let length = 0
      file.ondata = (error, chunk, final) => {
        if (failure) return
        if (error) {
          failure = error
          return
        }
        length += chunk.byteLength
        chunks.push(chunk.slice())
        if (final) {
          if (length !== entry.size) {
            failure = new BundleError(`entry ${file.name} has ${length} bytes; expected ${entry.size}.`)
            return
          }
          const data = new Uint8Array(length)
          let offset = 0
          for (const part of chunks) {
            data.set(part, offset)
            offset += part.byteLength
          }
          if (crc32(data) >>> 0 !== entry.crc) {
            failure = new BundleError(`entry ${file.name} failed CRC-32 verification.`)
            return
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
    for (let offset = 0; offset < archive.byteLength; offset += 16_384)
      unzip.push(archive.subarray(offset, offset + 16_384), offset + 16_384 >= archive.byteLength)
  } catch (error) {
    failure = error
  }
  if (failure) decodeFailure(failure)
  if (files.length !== expected.length)
    throw new BundleError(`decoded ${files.length} entries; the central directory declares ${expected.length}.`)
  return { files: files.filter(file => !file.path.endsWith('/')), special }
}

export function readBundleArchive(archive: Uint8Array) {
  const unpacked = unpack(archive)
  const bundle = validateBundle(indexedFiles(unpacked.files))
  for (const path of bundle.files.keys())
    if (unpacked.special.has(path)) throw new BundleError(`required entry ${path} is not a regular file.`)
  return bundle
}

export function createBundleArchive(configuration: RootConfiguration, resources: Iterable<BundleFile>) {
  const files = indexedFiles([
    { path: 'woof.config.json', data: strToU8(`${JSON.stringify(configuration, null, 2)}\n`) },
    ...resources,
  ])
  validateBundle(files)
  const archive = zipSync(Object.fromEntries(files) as Zippable, { level: 6 })
  return archive
}

/** A backup mirrors woof home paths, so extracting it over woof home restores those files. */
export function createBackupArchive(files: Iterable<BundleFile>) {
  return zipSync(Object.fromEntries(indexedFiles(files)) as Zippable, { level: 6 })
}
