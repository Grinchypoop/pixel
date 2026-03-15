// ─── Shared types for all Pixel agents ─────────────────────────────────────

export interface FileSpec {
  path: string;
  description: string;
}

export interface Plan {
  projectName: string;
  stack: string;
  description: string;
  folderStructure: string;
  files: FileSpec[];
  dependencies: string[];
  devDependencies: string[];
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  port?: number;
  envVars?: Record<string, string>;
}

export interface BuildResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  phase: 'install' | 'build' | 'complete';
}

export interface Fix {
  filePath: string;
  description: string;
  oldCode: string;
  newCode: string;
}

export interface DebugResult {
  analysis: string;
  fixes: Fix[];
}

export interface DeployResult {
  url: string;
  platform: 'railway' | 'vercel' | 'none';
  deploymentId?: string;
}

export interface OrchestratorResult {
  success: boolean;
  plan?: Plan;
  deployUrl?: string;
  error?: string;
  workDir?: string;
}

// ─── WebSocket event types ───────────────────────────────────────────────────

export type AgentName =
  | 'Orchestrator'
  | 'Planner'
  | 'Coder'
  | 'Debugger'
  | 'Deployer';

export type EventType =
  | 'agent_start'      // agent kicked off
  | 'agent_log'        // progress message
  | 'agent_thinking'   // Claude extended thinking
  | 'agent_complete'   // agent finished OK
  | 'agent_error'      // agent encountered an error
  | 'file_written'     // a file was created/updated
  | 'command_output'   // shell command stdout/stderr
  | 'pipeline_complete'// entire pipeline done — deployUrl attached
  | 'pipeline_error';  // unrecoverable failure

export interface AgentEvent {
  type: EventType;
  agent: AgentName;
  message: string;
  data?: unknown;
  sessionId: string;
  ts: number;
}

/** Call this to push events over the WebSocket to the frontend */
export type Emit = (event: AgentEvent) => void;
