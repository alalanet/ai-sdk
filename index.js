// @alalanet/ai-sdk: alalanet's install and payment checks in the Vercel AI SDK.
// toolApproval: alalanetApproval(opts) asks alalanet before a shell command or a payment runs.
// tools: installCheck(), preflightPayment(), checkRepoConfig() for the model to call itself.

export { alalanetApproval, commandsOf, readCommands, shellScript, DEFAULT_SHELL_TOOLS, PROCESS_TOOLS } from "./approval.js";
export { checkCommand, preflight, VERSION } from "./core.js";
export { isReadOnly, mustSend } from "./filter.js";
export { installCheck, preflightPayment, checkRepoConfig, alalanetTools } from "./tools.js";
