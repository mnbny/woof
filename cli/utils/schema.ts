import * as v from 'valibot'

import template from '../templates/woof.config.json' with { type: 'json' }

export const CURRENT_SCHEMA_VERSION = template.$schemaVersion

export type PromptResource = {
  $type: 'prompt'
  $exec: string
  $description?: string
  $tags?: string[]
  $private?: boolean
}

export type ScriptResource = {
  $type: 'bash' | 'node' | 'tsx' | 'bun'
  $exec: string | string[]
  $description?: string
  $tags?: string[]
  $private?: boolean
}

export type Resource = PromptResource | ScriptResource
export type TokenValue = string | Resource | TokenNamespace
export type TokenNamespace = { [key: string]: TokenValue }

export type ProjectMetadata = {
  $basePaths?: string[]
  $worktreePaths?: string[]
}

export type InlineProject = TokenNamespace & {
  $metadata?: ProjectMetadata
}

export type ProjectConfiguration = TokenNamespace & {
  $schemaVersion: typeof CURRENT_SCHEMA_VERSION
  $metadata?: ProjectMetadata
}

export type RootConfiguration = TokenNamespace & {
  $schemaVersion: typeof CURRENT_SCHEMA_VERSION
  $projects?: { [key: string]: string | InlineProject }
}

export const tokenNameSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_-]+$/, 'Token names contain only ASCII letters, digits, underscores and hyphens.'),
)

const metadataSchema = v.strictObject({
  $basePaths: v.exactOptional(v.array(v.string())),
  $worktreePaths: v.exactOptional(v.array(v.string())),
})

const promptResourceSchema = v.strictObject({
  $type: v.literal('prompt'),
  $exec: v.string(),
  $description: v.exactOptional(v.string()),
  $tags: v.exactOptional(v.array(v.string())),
  $private: v.exactOptional(v.boolean()),
})

const scriptResourceSchema = v.strictObject({
  $type: v.union([v.literal('bash'), v.literal('node'), v.literal('tsx'), v.literal('bun')]),
  $exec: v.union([v.string(), v.pipe(v.array(v.string()), v.minLength(1))]),
  $description: v.exactOptional(v.string()),
  $tags: v.exactOptional(v.array(v.string())),
  $private: v.exactOptional(v.boolean()),
})

export const resourceSchema = v.union([promptResourceSchema, scriptResourceSchema])

export const tokenValueSchema: v.GenericSchema<TokenValue> = v.lazy(() =>
  v.union([v.string(), resourceSchema, tokenNamespaceSchema]),
)

const tokenNamespaceSchema: v.GenericSchema<TokenNamespace> = v.record(tokenNameSchema, tokenValueSchema)

export const inlineProjectSchema: v.GenericSchema<InlineProject> = v.objectWithRest(
  { $metadata: v.exactOptional(metadataSchema) },
  tokenValueSchema,
)

export const projectConfigurationSchema: v.GenericSchema<ProjectConfiguration> = v.objectWithRest(
  {
    $schemaVersion: v.literal(CURRENT_SCHEMA_VERSION),
    $metadata: v.exactOptional(metadataSchema),
  },
  tokenValueSchema,
)

export const rootConfigurationSchema: v.GenericSchema<RootConfiguration> = v.objectWithRest(
  {
    $schemaVersion: v.literal(CURRENT_SCHEMA_VERSION),
    $projects: v.exactOptional(v.record(tokenNameSchema, v.union([v.string(), inlineProjectSchema]))),
  },
  tokenValueSchema,
)
