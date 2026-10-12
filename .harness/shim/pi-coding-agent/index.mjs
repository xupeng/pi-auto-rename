// Mock for @earendil-works/pi-coding-agent — only exports what pi-auto-rename
// imports at runtime (config.ts uses getAgentDir). Type-checking uses the real
// package types via tsconfig paths, so this shim only needs runtime values.
import { homedir } from "node:os";
import { join } from "node:path";

export function getAgentDir() {
  const envDir = process.env.PI_AGENT_DIR;
  if (envDir) return envDir;
  return join(homedir(), ".pi", "agent");
}

// Verbatim copy of pi's exported parser (dist/core/agent-session.js), which
// matches the block _expandSkillCommand() writes for `/skill:name args`.
export function parseSkillBlock(text) {
  const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return {
    name: match[1],
    location: match[2],
    content: match[3],
    userMessage: match[4]?.trim() || undefined,
  };
}

export class DynamicBorder {
  constructor() {}
  render() {
    return "";
  }
}
