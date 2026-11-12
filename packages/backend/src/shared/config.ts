export const PROMPT_SECTIONS = {
  persona: "persona",
  memory: "memory",
  computer: "computer",
  filesystem: "filesystem",
  skills: "skills",
  codemode: "codemode",
} as const;

export const CHAT_LOGIN_EXPIRED = 4401;
export const CHAT_EXPIRES_AT_HEADER = "X-Amita-Chat-Expires-At";

export const CONFIG = {
  loginLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  cookieName: "amita_owner",
  nameMaxLength: 80,
  personaMaxLength: 32_000,
  memoryCodePointLimit: 4_000,
  sessionTitleMaxLength: 120,
  searchQueryMaxLength: 256,
  searchResultLimit: 8,
  searchSnippetChars: 800,
  searchContextChars: 400,
  searchContextEntries: 8,
  messageMaxLength: 100_000,
  titleMaxLength: 64,
  sessionTitleInputChars: 4_000,
  sessionTitleOutputTokens: 128,
  sessionTitleTimeoutMs: 15_000,
  historyPageSize: 40,
  reconnectDelayMs: 1_500,
  registrationLifetimeMs: 5 * 60_000,
  pairingConfirmationMs: 5 * 60_000,
  pairingPollMs: 1_500,
  computerSlugMaxLength: 32,
  computerFileDeadlineMs: 30_000,
  computerCommandResultGraceMs: 5_000,
  computerHeartbeatLeaseMs: 30_000,
  computerReadChunkBytes: 64 * 1024,
  computerReadMaxBytes: 1024 * 1024,
  binaryTransferTimeoutMs: 120_000,
  binaryImportMaxBytes: 20 * 1024 * 1024,
  binaryExportMaxBytes: 20 * 1024 * 1024,
  computerOutputSnapshotMaxBytes: 64 * 1024,
  workspaceDirectory: ".amita/workspaces",
  thinkingLevel: "high",
} as const;

export const COPY = {
  newSession: "New session",
  personaConflict: "Persona changed. Reload the latest version before saving.",
  personaTooLong: "Persona exceeds the 32,000-character limit.",
  memoryTooLong: "Memory exceeds the 4,000-character limit.",
  computerSlugInvalid: "Enter a valid Computer Slug.",
  computerSlugReserved: "This Computer Slug is already reserved. Choose another Slug.",
  pairingExpired: "Pairing confirmation expired. Generate a new registration code.",
  pairingCancelled: "Pairing was cancelled or revoked.",
  requestFailed: "The request failed. Please try again.",
  expired: "Your login session has expired. Sign in again.",
  configuration: "Configure the Owner password on the Worker.",
  badPassword: "Incorrect password.",
  rateLimited: "Too many attempts. Try again later.",
} as const;

export const AUTOMATION_LIMITS = {
  historyPageSize: 20,
  sourceMaxLength: 100_000,
} as const;

export const AUTOMATION_COPY = {
  createConflict: "This automation ID already belongs to a different definition.",
  invalidTimezone: "Enter a valid IANA time zone.",
  missingTimezone: "Report the current browser time zone or provide timezone explicitly.",
  invalidCron: "Enter a valid five-field cron expression.",
  invalidTime: "Enter a valid ISO date and time.",
  invalidCursor: "Invalid run history cursor.",
  emptyPatch: "Provide at least one automation field to update.",
  scriptFailure: "JavaScript execution failed.",
  futureTime: "Choose a future time.",
  missingProgram: "Provide JavaScript, an agent message, or both.",
  invalidSession: "Choose an available session belonging to this Agent.",
  sessionBusy: "The selected session is busy. The automation could not start its agent turn.",
  agentSettingsRequireMessage: "Session and model settings require an agent message.",
  invalidGuard:
    "JavaScript must return an object with runAgent: boolean and optional JSON context.",
  notFound: "Automation not found.",
} as const;

export const MODEL_REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const PROVIDER_COPY = {
  invalid: "Check the provider settings.",
  encryption: "Credential encryption is not configured.",
  decrypt: "Could not decrypt provider credentials. Check the credential encryption key.",
} as const;

export const MODEL_COPY = {
  discoveryFailed: "Could not load models. Try again or enter a model ID.",
  invalidSelection: "Choose a model from a configured provider.",
  missingAgent: "Choose an available model in Agent settings.",
  missingSession: "Choose an available model for this session.",
  busy: "Wait for the current task to finish before changing models.",
  unavailable: (model: { provider: string; modelId: string }) =>
    `Model “${model.provider} / ${model.modelId}” is unavailable. Choose an available model in the automation settings.`,
} as const;

export const unavailableModelLabel = (id: string) => `${id} (unavailable)`;
