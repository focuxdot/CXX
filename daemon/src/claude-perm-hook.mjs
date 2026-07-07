// PreToolUse hook logic — routes a Claude Code tool-use approval to the CXX daemon
// (→ phone). Runs as a short-lived process spawned by Claude Code per gated tool use.
//
// It is invoked as a MODE of the daemon itself (env CXX_PERM_HOOK=1), not a standalone
// script, so it works identically when the daemon runs from source (node) and when it is
// packaged as a SEA single binary (where sibling .mjs files don't exist on disk).
// main.mjs dispatches to runPermHook() when it sees CXX_PERM_HOOK in the environment.
//
// Claude passes the request JSON on stdin ({ session_id, tool_name, tool_input,
// tool_use_id, cwd, ... }). We POST it to the daemon's localhost approval endpoint and
// block until the phone decides, then emit the PreToolUse decision Claude expects.
// Empirically PreToolUse hooks DO gate tools in headless `-p` mode (unlike
// --permission-prompt-tool, which is not consulted there).
//
// Fail-closed: any transport error / timeout → deny (safer than silently running).
import { readFileSync } from "node:fs";
import { request } from "node:http";

export async function runPermHook(url, token) {
  const decide = (permissionDecision, reason) => {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason },
      }),
    );
    process.exit(0);
  };

  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    // no/invalid stdin
  }

  // No endpoint wired → allow (a backend without approval routing must not brick turns).
  if (!url || !token) return decide("allow", "CXX: 未配置审批端点");

  const payload = JSON.stringify({
    token,
    sessionId: input.session_id,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    toolUseId: input.tool_use_id,
    cwd: input.cwd,
  });

  try {
    const u = new URL(url);
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const r = JSON.parse(body);
            decide(r.decision === "allow" ? "allow" : "deny", r.reason || "CXX 远程审批");
          } catch {
            decide("deny", "CXX: 审批响应异常");
          }
        });
      },
    );
    req.on("error", () => decide("deny", "CXX: 无法连接审批端点"));
    // Generous ceiling: approvals may sit until a device comes online to decide.
    req.setTimeout(10 * 60 * 1000, () => {
      req.destroy();
      decide("deny", "CXX: 审批超时");
    });
    req.write(payload);
    req.end();
  } catch {
    decide("deny", "CXX: 审批请求失败");
  }
}

// Allow running standalone too (dev/debug): node claude-perm-hook.mjs <url> <token>
if (process.env.CXX_PERM_HOOK === "1" && import.meta.url === `file://${process.argv[1]}`) {
  runPermHook(process.env.CXX_APPROVE_URL, process.env.CXX_APPROVE_TOKEN);
}
