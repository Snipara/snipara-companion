import { createClient } from "../api/client";
import { isConfigured } from "../config/store";

interface SwarmCreateOptions {
  name: string;
  description?: string;
  maxAgents?: number;
  taskTimeout?: number;
  claimTimeout?: number;
  json?: boolean;
}

interface SwarmJoinOptions {
  swarmId: string;
  agentId: string;
  name?: string;
  role?: string;
  capabilities?: string[];
  json?: boolean;
}

function ensureConfigured(): void {
  if (!isConfigured()) {
    console.log("Not configured. Run 'npx -y snipara-companion@latest init' first.");
    process.exit(1);
  }
}

function printResult(result: unknown, json = false): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

export async function swarmCreateCommand(options: SwarmCreateOptions): Promise<void> {
  ensureConfigured();
  const client = createClient(30000);
  const result = await client.callTool<Record<string, unknown>>("snipara_swarm_create", {
    name: options.name,
    description: options.description,
    max_agents: options.maxAgents,
    task_timeout: options.taskTimeout,
    claim_timeout: options.claimTimeout,
  });

  printResult(result, options.json);
}

export async function swarmJoinCommand(options: SwarmJoinOptions): Promise<void> {
  ensureConfigured();
  const client = createClient(30000);
  const result = await client.callTool<Record<string, unknown>>("snipara_swarm_join", {
    swarm_id: options.swarmId,
    agent_id: options.agentId,
    name: options.name,
    role: options.role,
    capabilities: options.capabilities ?? [],
  });

  printResult(result, options.json);
}
