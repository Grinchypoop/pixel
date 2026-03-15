import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const BASE_DIR =
  process.env.PIXEL_WORK_DIR || path.join(os.tmpdir(), '.pixel-work');

export async function createWorkDir(sessionId: string): Promise<string> {
  const workDir = path.join(BASE_DIR, sessionId);
  await fs.ensureDir(workDir);
  return workDir;
}

export async function writeProjectFile(
  workDir: string,
  filePath: string,
  content: string,
): Promise<string> {
  // Prevent path traversal — keep everything inside workDir
  const safe = path.resolve(workDir, filePath);
  if (!safe.startsWith(path.resolve(workDir))) {
    throw new Error(`Path traversal attempt: ${filePath}`);
  }
  await fs.ensureDir(path.dirname(safe));
  await fs.writeFile(safe, content, 'utf-8');
  return safe;
}

export async function readProjectFile(
  workDir: string,
  filePath: string,
): Promise<string> {
  const safe = path.resolve(workDir, filePath);
  if (!safe.startsWith(path.resolve(workDir))) {
    throw new Error(`Path traversal attempt: ${filePath}`);
  }
  return fs.readFile(safe, 'utf-8');
}

export async function fileExists(
  workDir: string,
  filePath: string,
): Promise<boolean> {
  const safe = path.resolve(workDir, filePath);
  return fs.pathExists(safe);
}

export async function listProjectFiles(workDir: string): Promise<string[]> {
  const entries = await fs.readdir(workDir, {
    recursive: true,
    withFileTypes: true,
  });
  return (entries as fs.Dirent[])
    .filter((e) => e.isFile())
    .map((e) => {
      const dir = typeof e.path === 'string' ? e.path : workDir;
      return path.relative(workDir, path.join(dir, e.name));
    });
}
