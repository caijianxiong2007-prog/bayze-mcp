export * from './domain/types.js';
export { ok, err } from './domain/errors.js';
export type { Result } from './domain/errors.js';
export * from './config/schema.js';
export { loadConfig, formatConfigError } from './config/loader.js';
export type { ConfigLoadError, ConfigIssue } from './config/loader.js';
export { defaultConfigDir, defaultConfigPath } from './config/paths.js';
export { CredentialStore } from './credentials/store.js';
export type { CredentialError } from './credentials/store.js';
export { redactText, redactProviderErrorBody } from './logging/redact.js';
export { createProvider } from './providers/registry.js';
export type { RegistryError } from './providers/registry.js';
export { MockProvider } from './providers/mock/provider.js';
export type {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderError,
  ProviderKind,
  AdapterCapabilities,
} from './providers/types.js';
