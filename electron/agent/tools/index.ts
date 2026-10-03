/**
 * Central tool registration (design §1 "Tool Registration at Startup").
 *
 * Every shipped tool kit is imported and registered here so callers — chiefly
 * `electron/ipc/agent.ts` — only need `registerAllTools(registry)`. Tools take
 * no construction-time context: the runtime `AgentContext` (db, window,
 * sessionId) is handed to each tool's `execute` by the ToolRunner.
 *
 *   Sprint 1: memory, finance
 *   Sprint 2: calendar, messages, email (macOS automation) + permissions_check
 *   Sprint 4: web (search + fetch), quickbooks (QBO REST API)
 *   Parity: goals + plans (agent-authored plans the user reviews), GitHub
 *   research, self-improvement lessons, jailed Python, git integration.
 */
import type { ToolRegistry } from "../toolRegistry";
import { memoryTools } from "./memory";
import { financeTools } from "./finance";
import { calendarTools } from "./calendar";
import { messagesTools } from "./messages";
import { emailTools } from "./email";
import { permissionsTools } from "./permissions";
import { webTools } from "./web";
import { shellTools } from "./shell";
import { renderTools } from "./render";
import { quickbooksTools } from "./quickbooks";
import { bookTools } from "./book";
import { repoTools } from "./repo";
import { machineTools } from "./machines";
import { fileTools } from "./files";
import { goalsTools } from "./goals";
import { plansTools } from "./plans";
import { githubTools } from "./github";
import { lessonsTools } from "./lessons";
import { pythonTools } from "./python";
import { credentialTools } from "./credentials";
import { integrationTools } from "../../integrations";

export function registerAllTools(registry: ToolRegistry): void {
  registry.registerAll([
    ...memoryTools(),
    ...financeTools(),
    ...bookTools(),
    ...calendarTools(),
    ...messagesTools(),
    ...emailTools(),
    ...permissionsTools(),
    ...webTools(),
    ...shellTools(),
    ...renderTools(),
    ...quickbooksTools(),
    ...repoTools(),
    ...machineTools(),
    ...goalsTools(),
    ...plansTools(),
    ...githubTools(),
    ...lessonsTools(),
    ...pythonTools(),
    ...credentialTools(),
    ...integrationTools(),
    ...fileTools,
  ]);
}
