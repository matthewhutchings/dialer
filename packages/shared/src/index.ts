// Shared domain core: backend and SPA import from here, never copy it.
// Boundary rule: this package imports nothing from backend/ or frontend/.
//
// NOTE: `./api` (the generated Twenty GraphQL client) is a separate export
// — see package.json exports — so consumers that only need domain logic
// never load the megabyte-sized generated schema.
export * from "./oauth.js";
export * from "./dialerQueue.js";
export type { CallTask, CallTaskSync } from "./callTasks.js";
export * from "./domains/index.js";
export type { AiAgentProfile, AiAgentSettings, AiQueueEntry, AiAutomationRun, AiAutomationView, AiCallInput, AiCallView, AiVoiceConfigView } from "./aiVoice.js";
