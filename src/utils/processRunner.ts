import { spawn } from 'child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/** Allowed command prefixes — prevents arbitrary code execution */
const ALLOWED_PREFIXES = [
  'npm ',
  'npx ',
  'node ',
  'yarn ',
  'pnpm ',
  'tsc',
  'next ',
  'vite ',
];

function isAllowed(command: string): boolean {
  const cmd = command.trim().toLowerCase();
  return ALLOWED_PREFIXES.some((p) => cmd.startsWith(p));
}

/**
 * Run a shell command in a given directory.
 * `onOutput` receives stdout/stderr lines in real-time.
 */
export async function runCommand(
  command: string,
  cwd: string,
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void,
  timeoutMs = 180_000,
): Promise<RunResult> {
  if (!isAllowed(command)) {
    return {
      stdout: '',
      stderr: `Command not allowed: ${command}`,
      exitCode: 1,
      success: false,
    };
  }

  return new Promise((resolve) => {
    const proc = spawn(command, {
      cwd,
      shell: true,
      stdio: 'pipe',
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        stdout,
        stderr: stderr + '\n[TIMEOUT] Process killed after timeout',
        exitCode: 124,
        success: false,
      });
    }, timeoutMs);

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      onOutput?.(text, 'stdout');
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      onOutput?.(text, 'stderr');
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = code ?? 1;
      resolve({ stdout, stderr, exitCode, success: exitCode === 0 });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: 1, success: false });
    });
  });
}
