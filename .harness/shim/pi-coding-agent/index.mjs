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

export class DynamicBorder {
  constructor() {}
  render() {
    return "";
  }
}
