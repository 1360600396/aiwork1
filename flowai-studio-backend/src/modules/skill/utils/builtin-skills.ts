import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WORKSPACE_ROOT = path.resolve(process.cwd(), '..');
const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
]);
const DEFAULT_TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.example',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.prisma',
  '.scss',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

export async function executeBuiltinSkill(type: string, params: Record<string, any>): Promise<any> {
  switch (type) {
    case 'time':
      return executeTimeSkill();
    case 'http':
      return executeHttpSkill(params);
    case 'json':
      return executeJsonSkill(params);
    case 'regex':
      return executeRegexSkill(params);
    case 'code_list':
      return executeCodeListSkill(params);
    case 'code_read':
      return executeCodeReadSkill(params);
    case 'code_search':
      return executeCodeSearchSkill(params);
    default:
      throw new Error(`Unknown builtin skill type: ${type}`);
  }
}

function executeTimeSkill(): any {
  const now = new Date();
  return {
    datetime: now.toISOString(),
    timestamp: now.getTime(),
    date: now.toDateString(),
    time: now.toTimeString(),
  };
}

async function executeHttpSkill(params: any): Promise<any> {
  const { url, method = 'GET', headers = {}, body } = params;

  if (!url) {
    throw new Error('URL is required for HTTP skill');
  }

  try {
    const response = await axios({
      url,
      method,
      headers,
      data: body,
    });

    return {
      status: response.status,
      data: response.data,
      headers: response.headers,
    };
  } catch (error) {
    throw new Error(`HTTP request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function executeJsonSkill(params: any): any {
  const { action, data } = params;

  if (!action) {
    throw new Error('Action is required for JSON skill');
  }

  switch (action) {
    case 'parse':
      if (typeof data !== 'string') {
        throw new Error('Data must be a string for parse action');
      }
      try {
        return { result: JSON.parse(data) };
      } catch (error) {
        throw new Error('Invalid JSON');
      }
    case 'stringify':
      try {
        return { result: JSON.stringify(data) };
      } catch (error) {
        throw new Error('Failed to stringify data');
      }
    default:
      throw new Error(`Unknown JSON action: ${action}`);
  }
}

function executeRegexSkill(params: any): any {
  const { text, pattern, flags = '' } = params;

  if (!text || !pattern) {
    throw new Error('Text and pattern are required for regex skill');
  }

  try {
    const regex = new RegExp(pattern, flags);
    const matches = text.match(regex);

    return {
      matches: matches || [],
      groups: matches?.groups || {},
    };
  } catch (error) {
    throw new Error(`Invalid regex pattern: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function resolveWorkspacePath(inputPath = '.'): string {
  const rawInput = String(inputPath || '.');
  const resolvedPath = path.isAbsolute(rawInput)
    ? path.resolve(rawInput)
    : path.resolve(WORKSPACE_ROOT, rawInput);

  if (!isInsideAllowedCodeRoots(resolvedPath)) {
    throw new Error('Path is outside of local code roots');
  }

  return resolvedPath;
}

function toWorkspaceRelative(absolutePath: string): string {
  if (absolutePath === WORKSPACE_ROOT || absolutePath.startsWith(`${WORKSPACE_ROOT}${path.sep}`)) {
    return path.relative(WORKSPACE_ROOT, absolutePath) || '.';
  }

  return absolutePath;
}

function getAllowedCodeRoots(): string[] {
  const configuredRoots = process.env.LOCAL_CODE_ROOTS;
  const roots = configuredRoots
    ? configuredRoots.split(',').map((root) => root.trim()).filter(Boolean)
    : [os.homedir(), WORKSPACE_ROOT];

  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

function isInsideAllowedCodeRoots(resolvedPath: string): boolean {
  return getAllowedCodeRoots().some((root) => {
    return resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`);
  });
}

function isExcludedDir(dirName: string): boolean {
  return DEFAULT_EXCLUDED_DIRS.has(dirName);
}

function looksTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath).toLowerCase();
  if (baseName.startsWith('.env') && baseName !== '.env.example') return false;

  if (DEFAULT_TEXT_EXTENSIONS.has(ext)) return true;

  return baseName === 'dockerfile';
}

function executeCodeListSkill(params: any): any {
  const dirPath = resolveWorkspacePath(params?.path || '.');
  const maxEntries = Math.min(Number(params?.maxEntries || 200), 500);

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error('Path must be a directory');
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => !isExcludedDir(entry.name))
    .slice(0, maxEntries)
    .map((entry) => {
      const absolutePath = path.join(dirPath, entry.name);
      const entryStat = fs.statSync(absolutePath);
      return {
        name: entry.name,
        path: toWorkspaceRelative(absolutePath),
        type: entry.isDirectory() ? 'directory' : 'file',
        size: entryStat.size,
      };
    });

  return {
    root: WORKSPACE_ROOT,
    path: toWorkspaceRelative(dirPath),
    entries,
  };
}

function executeCodeReadSkill(params: any): any {
  const filePath = resolveWorkspacePath(params?.path);
  const maxBytes = Math.min(Number(params?.maxBytes || 60000), 200000);

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error('Path must be a file');
  }

  if (!looksTextFile(filePath)) {
    throw new Error('Only text/code files can be read');
  }

  const buffer = fs.readFileSync(filePath);
  const truncated = buffer.length > maxBytes;
  const content = buffer.subarray(0, maxBytes).toString('utf-8');

  return {
    path: toWorkspaceRelative(filePath),
    size: stat.size,
    truncated,
    content,
  };
}

function executeCodeSearchSkill(params: any): any {
  const query = String(params?.query || '').trim();
  if (!query) {
    throw new Error('Query is required');
  }

  const startPath = resolveWorkspacePath(params?.path || '.');
  const maxResults = Math.min(Number(params?.maxResults || 50), 200);
  const maxFileBytes = Math.min(Number(params?.maxFileBytes || 200000), 500000);
  const results: Array<{ path: string; line: number; preview: string }> = [];

  const walk = (currentPath: string) => {
    if (results.length >= maxResults) return;

    const stat = fs.statSync(currentPath);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
        if (isExcludedDir(entry.name)) continue;
        walk(path.join(currentPath, entry.name));
        if (results.length >= maxResults) return;
      }
      return;
    }

    if (!stat.isFile() || stat.size > maxFileBytes || !looksTextFile(currentPath)) return;

    const content = fs.readFileSync(currentPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const lowerQuery = query.toLowerCase();

    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].toLowerCase().includes(lowerQuery)) {
        results.push({
          path: toWorkspaceRelative(currentPath),
          line: index + 1,
          preview: lines[index].trim().slice(0, 300),
        });
        if (results.length >= maxResults) return;
      }
    }
  };

  walk(startPath);

  return {
    root: WORKSPACE_ROOT,
    query,
    path: toWorkspaceRelative(startPath),
    results,
  };
}
