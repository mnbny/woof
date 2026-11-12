import * as v from 'valibot'

import template from '../templates/woof.config.json' with { type: 'json' }

export const CURRENT_SCHEMA_VERSION = template.$schemaVersion

export type SecretBindings = Record<string, string>

export const argumentDescriptionsSchema = v.array(
  v.strictObject({
    name: v.pipe(v.string(), v.minLength(1)),
    description: v.exactOptional(v.string()),
  }),
)
export type ArgumentDescriptions = v.InferOutput<typeof argumentDescriptionsSchema>

export const tokenNameSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_-]+$/, 'Token names contain only ASCII letters, digits, underscores and hyphens.'),
  v.check(
    value => !['__proto__', 'prototype', 'constructor'].includes(value),
    'Prototype-sensitive token names are not supported.',
  ),
)

export const tokenPathSchema = v.pipe(
  v.string(),
  v.check(value => value.split('.').every(part => v.is(tokenNameSchema, part)), 'Invalid token path.'),
)

export const secretBindingsSchema = v.record(
  v.pipe(
    v.string(),
    v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Secret environment names must be shell identifiers.'),
    v.check(
      value => !['__proto__', 'prototype', 'constructor', 'CI'].includes(value) && !value.startsWith('npm_config_'),
      'This environment name is reserved.',
    ),
  ),
  tokenPathSchema,
)

export type PromptResource = {
  $type: 'prompt'
  $exec: string
  $description?: string
  $tags?: string[]
  $private?: boolean
  $secrets?: SecretBindings
}

export type ScriptResource = {
  $type: 'bash' | 'node' | 'tsx' | 'bun'
  $exec: string | string[]
  $description?: string
  $tags?: string[]
  $private?: boolean
  $secrets?: SecretBindings
  $arguments?: ArgumentDescriptions
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
  $secrets: v.exactOptional(secretBindingsSchema),
})

const scriptResourceSchema = v.strictObject({
  $type: v.union([v.literal('bash'), v.literal('node'), v.literal('tsx'), v.literal('bun')]),
  $exec: v.union([v.string(), v.pipe(v.array(v.string()), v.minLength(1))]),
  $description: v.exactOptional(v.string()),
  $tags: v.exactOptional(v.array(v.string())),
  $private: v.exactOptional(v.boolean()),
  $secrets: v.exactOptional(secretBindingsSchema),
  $arguments: v.exactOptional(argumentDescriptionsSchema),
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
