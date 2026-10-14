/**
 * Gnito — shared types used by both client and server.
 * Kept dependency-free except zod for runtime validation.
 */
import { z } from 'zod';

// ---------------------------------------------------------------- providers

export const ProviderKindSchema = z.enum(['openai-compatible', 'anthropic-compatible', 'custom']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/** Non-secret provider configuration (safe to send to client). */
export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  kind: ProviderKindSchema,
  /** Human-readable name, e.g. "OpenAI" or "My local Ollama". */
  label: z.string().min(1).max(100),
  /** Base URL, e.g. https://api.openai.com/v1 — never contains the API key. */
  baseUrl: z.string().url(),
  /** Enabled/disabled; disabled providers are skipped in UI selectors. */
  enabled: z.boolean().default(true),
  /** Optional custom headers — validated server-side; never contains Authorization. */
  customHeaders: z.record(z.string(), z.string()).default({}),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** What the client sees for a provider's models (no key included). */
export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  capabilities: z.array(z.enum(['text', 'vision', 'tool-calling', 'json-output', 'audio-input', 'audio-output'])).default([]),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/** Provider "test connection" response — no credential content. */
export const ProviderTestResultSchema = z.object({
  ok: z.boolean(),
  /** Non-credential error message (redacted). */
  error: z.string().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  models: z.array(ModelInfoSchema).default([]),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;

// ------------------------------------------------------------------ chat

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  role: ChatRoleSchema,
  content: z.string(),
  /** Provider id that generated this (for assistant messages). */
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  /** Tokens/usage reported by the provider, if any. */
  usage: z.record(z.string(), z.number()).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatStatusSchema = z.enum(['active', 'archived']);
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

export const ChatSchema = z.object({
  id: z.string().min(1),
  /** Null = no project. */
  projectId: z.string().nullable().default(null),
  title: z.string().min(1).max(300).default('New chat'),
  status: ChatStatusSchema.default('active'),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Chat = z.infer<typeof ChatSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  /** Optional project-level instructions injected into every chat in this project. */
  instructions: z.string().max(5000).default(''),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Project = z.infer<typeof ProjectSchema>;

// ---------------------------------------------------------------- memory

export const MemoryEntrySchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1).max(200),
  value: z.string().max(5000),
  /** Why this memory was saved (explanation shown to the user). */
  reason: z.string().max(500).default(''),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

// ------------------------------------------------------------------- tools

export const ToolPermissionSchema = z.enum([
  'files:read',
  'files:write',
  'files:delete',
  'terminal:run',
  'network:web-search',
  'network:fetch-url',
  'git:read',
  'git:write',
  'github:read',
  'github:write',
  'plugin:*',
  'automation:*',
]);
export type ToolPermission = z.infer<typeof ToolPermissionSchema>;

/** A single file/folder grant to a specific tool scope. */
export const FileGrantSchema = z.object({
  id: z.string().min(1),
  /** Absolute real path (post-symlink resolution) of the approved folder. */
  rootPath: z.string().min(1),
  label: z.string().min(1).max(200),
  permissions: z.array(ToolPermissionSchema).min(1),
  createdAt: z.number().int().nonnegative(),
});
export type FileGrant = z.infer<typeof FileGrantSchema>;

/** A tool call that has been made or is awaiting approval. */
export const ToolRunSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  /** JSON string of the input (redacted of secrets). */
  input: z.string(),
  /** JSON string of the output (redacted of secrets); set when complete. */
  output: z.string().optional(),
  status: z.enum(['pending-approval', 'running', 'succeeded', 'failed', 'cancelled', 'denied']).default('pending-approval'),
  error: z.string().optional(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  /** Conversation or automation that triggered it (never an incognito chat id). */
  context: z.string().optional(),
});
export type ToolRun = z.infer<typeof ToolRunSchema>;

// -------------------------------------------------------------- automations

export const AutomationScheduleSchema = z.object({
  /** Cron-style expression (5 fields) OR a specific ISO timestamp for one-shot. */
  expression: z.string().min(1).max(120),
  timezone: z.string().min(1).max(120),
  /** one-shot | recurring */
  kind: z.enum(['one-shot', 'recurring']).default('recurring'),
});
export type AutomationSchedule = z.infer<typeof AutomationScheduleSchema>;

export const AutomationStatusSchema = z.enum(['draft', 'active', 'paused', 'completed', 'failed']);
export type AutomationStatus = z.infer<typeof AutomationStatusSchema>;

export const MissedRunPolicySchema = z.enum(['skip', 'run-once-on-startup', 'catch-up-within-window']);
export type MissedRunPolicy = z.infer<typeof MissedRunPolicySchema>;

export const AutomationSchema = z.object({
  id: z.string().min(1),
  /** The natural-language prompt the user typed. */
  prompt: z.string().min(1).max(5000),
  /** Parsed/reviewed schedule the user approved. */
  schedule: AutomationScheduleSchema,
  /** What the model will be asked to do, derived from prompt + clarifications. */
  taskInstruction: z.string().max(10000),
  status: AutomationStatusSchema.default('draft'),
  /** Missed-run policy when the service was down. */
  missedRunPolicy: MissedRunPolicySchema.default('skip'),
  /** If missedRunPolicy = catch-up-within-window, how many missed occurrences to replay (max 3). */
  catchUpWindowMs: z.number().int().nonnegative().max(24 * 3600_000).default(0),
  /** Dry-run/preview flag: if true, agent runs but no tool side-effects. */
  dryRun: z.boolean().default(false),
  /** Max agent steps per run. */
  maxSteps: z.number().int().positive().max(50).default(10),
  /** Retry policy. */
  maxRetries: z.number().int().nonnegative().max(5).default(1),
  retryBackoffMs: z.number().int().nonnegative().max(60_000).default(30_000),
  /** Concurrency: at most one run per automation at a time. */
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Next run timestamp (ISO ms) — set when active. */
  nextRunAt: z.number().int().nonnegative().optional(),
});
export type Automation = z.infer<typeof AutomationSchema>;

export const AutomationRunStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'missed', 'skipped-by-policy']);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

export const AutomationRunSchema = z.object({
  id: z.string().min(1),
  automationId: z.string().min(1),
  /** Idempotency key — set on creation to prevent duplicate scheduling of same occurrence. */
  occurrenceKey: z.string().min(1),
  status: AutomationRunStatusSchema.default('pending'),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  /** Human-readable result/output summary (last 10 KB). */
  resultSummary: z.string().max(10_000).optional(),
  /** Tool runs this run made (ids). */
  toolRunIds: z.array(z.string()).default([]),
  error: z.string().max(2000).optional(),
  /** Number of agent steps consumed. */
  stepsUsed: z.number().int().nonnegative().default(0),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

// ------------------------------------------------------------------ plugins

export const PluginPermissionSchema = z.enum([
  'files:read',
  'files:write',
  'files:delete',
  'terminal:run',
  'network:fetch',
  'network:web-search',
  'git:read',
  'git:write',
  'github:read',
  'github:write',
  'mcp:connect',
  'memory:read',
  'memory:write',
]);
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

/** Plugin manifest — read from the plugin's manifest.json. */
export const PluginManifestSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/, 'semver'),
  description: z.string().max(2000),
  author: z.string().max(200),
  license: z.string().max(100),
  /** Minimum Gnito version this plugin supports. */
  gnitoVersion: z.string().regex(/^\d+\.\d+\.\d+/).default('0.1.0'),
  permissions: z.array(PluginPermissionSchema).min(0).max(20),
  /** Tool names this plugin exposes. */
  tools: z.array(z.string().min(1).max(100)).default([]),
  /** Configuration schema the plugin accepts (validated as a Zod schema). */
  configSchema: z.record(z.string(), z.unknown()).optional(),
  /** MCP server URLs the plugin wants to connect to. */
  mcpServers: z.array(z.object({
    name: z.string().min(1).max(100),
    command: z.string().max(500).optional(),
    url: z.string().url().optional(),
    transport: z.enum(['stdio', 'http']).default('stdio'),
  })).default([]),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PluginInstallStateSchema = z.enum(['installed', 'disabled', 'error', 'incompatible']);
export type PluginInstallState = z.infer<typeof PluginInstallStateSchema>;

// ------------------------------------------------------------------ backups

export const BackupOptionsSchema = z.object({
  /** Include chat messages, projects, chats metadata. */
  includeChats: z.boolean().default(true),
  includeProjects: z.boolean().default(true),
  includeSettings: z.boolean().default(true),
  includePlugins: z.boolean().default(true),
  includeAutomations: z.boolean().default(true),
  includeMemory: z.boolean().default(true),
  /** Include provider API keys — requires explicit opt-in + strong warning. */
  includeSecrets: z.boolean().default(false),
  /** Include user files (approved folders) — size-capped. */
  includeFiles: z.boolean().default(false),
});
export type BackupOptions = z.infer<typeof BackupOptionsSchema>;

export const BackupHeaderSchema = z.object({
  formatVersion: z.literal(1),
  createdAt: z.number().int().nonnegative(),
  /** Included sections (per BackupOptions). */
  included: BackupOptionsSchema,
  /** Total archive size in bytes (before encryption). */
  plaintextSize: z.number().int().nonnegative(),
  /** Random 16-byte salt (hex) used for key derivation. */
  salt: z.string().length(32),
  /** Random 12-byte nonce (hex) used for AES-256-GCM. */
  nonce: z.string().length(24),
});
export type BackupHeader = z.infer<typeof BackupHeaderSchema>;
