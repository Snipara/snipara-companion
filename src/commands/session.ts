/**
 * `session` commands — local session lifecycle.
 *
 * `session-end` (the Stop hook) persists the current session's tracked context
 * to hosted Snipara and rotates the local session id; `session status` and
 * `session reset` inspect and clear local session state. All commands no-op
 * cleanly when the workspace is not configured.
 */
import { createClient } from "../api/client";
import { isConfigured, loadConfig, saveConfig } from "../config/store";
import { emitCanonicalEvent } from "./events";

/**
 * Session end handler: Persist session context
 */
export async function sessionEndCommand(): Promise<void> {
  // Check if configured
  if (!isConfigured()) {
    console.log("Not configured. Run 'npx -y snipara-companion@latest init' first.");
    process.exit(0);
  }

  try {
    const client = createClient(30000); // 30s timeout for persist
    const result = await client.persistSession();
    await emitCanonicalEvent({
      eventType: "session_end",
      payload: {
        persisted: true,
        files_tracked: result.files_tracked,
      },
    });

    console.log(`✓ Session saved (${result.files_tracked} files tracked)`);

    // Generate new session ID for next time
    const newSessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    saveConfig({ sessionId: newSessionId });
  } catch (error) {
    await emitCanonicalEvent({
      eventType: "session_end",
      payload: {
        persisted: false,
        offline: true,
      },
    });

    if (process.env.RLM_DEBUG) {
      console.error(
        `[Snipara] Session error: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
    console.log("Session ended (offline)");
  }
}

/**
 * Get current session status
 */
export async function sessionStatusCommand(): Promise<void> {
  // Check if configured
  if (!isConfigured()) {
    console.log("Not configured. Run 'npx -y snipara-companion@latest init' first.");
    process.exit(1);
  }

  const config = loadConfig();

  console.log("\n📊 Session Status\n");
  console.log(`Session ID: ${config.sessionId || "none"}`);

  try {
    const client = createClient(5000);
    const status = await client.getSession();

    console.log(`Files tracked: ${status.files_tracked}`);
    console.log("Status: Active");
  } catch {
    console.log("Status: Offline (cannot reach API)");
  }

  console.log();
}

/**
 * Reset session (start fresh)
 */
export function sessionResetCommand(): void {
  const newSessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  saveConfig({ sessionId: newSessionId });

  console.log("✓ Session reset");
  console.log(`New session ID: ${newSessionId}`);
}
