/**
 * Shared Dynamic Data Store & Writable Filesystem Fallback (src/lib/dataStore.ts)
 * Unified Storage Directory Resolver & Zero-Crash Memory Cache:
 * - On Vercel / serverless (process.env.VERCEL or process.cwd().startsWith('/var/task')): path.join('/tmp', 'revo-data')
 * - Locally / standard Node.js: path.join(process.cwd(), '.data')
 *
 * Guaranteed zero ENOENT / EROFS runtime crashes:
 * - In-memory fallback cache (globalThis.__NEMESIS_MEMORY_STORE__ & globalThis.__QUANT_MEMORY_STORE__)
 * - Seed file loading from path.join(process.cwd(), 'data', filename) and .data
 * - All fs operations (mkdirSync, readFileSync, writeFileSync, readFile, writeFile) wrapped in safe try/catch blocks
 */

const fs = typeof window === "undefined" ? eval("require")("fs") : null;
const path = typeof window === "undefined" ? eval("require")("path") : null;

declare global {
  // eslint-disable-next-line no-var
  var __NEMESIS_MEMORY_STORE__: Record<string, any> | undefined;
  // eslint-disable-next-line no-var
  var __QUANT_MEMORY_STORE__: Map<string, string> | undefined;
}

/**
 * Global In-Memory Fallback Store (NEMESIS)
 * Mirrors every saved JSON payload into memory so saving/reading credentials and config
 * succeeds 100% of the time across serverless lambda invocations without throwing ENOENT/EROFS.
 */
export function getNemesisMemoryStore(): Record<string, any> {
  if (!globalThis.__NEMESIS_MEMORY_STORE__) {
    globalThis.__NEMESIS_MEMORY_STORE__ = {};
  }
  return globalThis.__NEMESIS_MEMORY_STORE__;
}

/**
 * Backward compatibility in-memory map
 */
export function getMemoryStore(): Map<string, string> {
  if (!globalThis.__QUANT_MEMORY_STORE__) {
    globalThis.__QUANT_MEMORY_STORE__ = new Map<string, string>();
  }
  return globalThis.__QUANT_MEMORY_STORE__;
}

/**
 * Checks whether the current process is running in Vercel or AWS Lambda Serverless environment
 */
export function isServerless(): boolean {
  if (process.env.VERCEL) return true;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return true;
  try {
    if (typeof process.cwd === 'function' && process.cwd().startsWith('/var/task')) {
      return true;
    }
  } catch {}
  return false;
}

/**
 * Safely ensures directory exists without throwing ENOENT or EROFS
 */
export function safeMkdirSync(dirPath: string): boolean {
  if (!fs || !dirPath) return false;
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return true;
  } catch (err) {
    console.warn(`[dataStore] safeMkdirSync warning for ${dirPath}:`, err);
    return false;
  }
}

/**
 * Returns Unified Dynamic Storage Directory path:
 * - On Vercel / serverless: path.join('/tmp', 'revo-data')
 * - Locally / standard Node: path.join(process.cwd(), '.data')
 * Always guarantees safe mkdirSync inside try/catch.
 */
export function getDataDir(): string {
  if (process.env.DATA_DIR) {
    safeMkdirSync(process.env.DATA_DIR);
    return process.env.DATA_DIR;
  }
  const targetDir = isServerless()
    ? path.join('/tmp', 'revo-data')
    : path.join(process.cwd(), '.data');

  safeMkdirSync(targetDir);
  return targetDir;
}

/**
 * Resolves absolute path to a file inside dynamic DATA_DIR
 */
export function resolveDataFilePath(filename: string): string {
  return path.join(getDataDir(), filename);
}

/**
 * Resolves absolute path to initial seed file (checks data/ then .data/)
 */
export function getSeedFilePath(filename: string): string {
  try {
    const p1 = path.join(process.cwd(), 'data', filename);
    if (fs && fs.existsSync(p1)) return p1;
    const p2 = path.join(process.cwd(), '.data', filename);
    if (fs && fs.existsSync(p2)) return p2;
    return p1;
  } catch {
    return path.join(process.cwd(), 'data', filename);
  }
}

/**
 * Safely reads a data file synchronously.
 * 1. Checks in-memory store (globalThis.__NEMESIS_MEMORY_STORE__ / __QUANT_MEMORY_STORE__)
 * 2. Checks dynamic DATA_DIR (/tmp/revo-data or .data)
 * 3. Falls back to project seed files (data/ or .data/)
 * 4. Falls back to defaultContent
 * 5. Updates in-memory stores safely
 */
export function readDataFile(filename: string, defaultContent: string = ''): string {
  const nemesis = getNemesisMemoryStore();

  // 1. Fast in-memory hit from NEMESIS store
  if (filename in nemesis) {
    const val = nemesis[filename];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val;
    } else if (val !== undefined && val !== null) {
      return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
    }
  }

  // Check QUANT memory map
  const mem = getMemoryStore();
  if (mem.has(filename)) {
    const cached = mem.get(filename);
    if (cached !== undefined && cached.trim().length > 0) {
      return cached;
    }
  }

  const primaryPath = resolveDataFilePath(filename);
  let content: string | null = null;

  // 2. Try reading from dynamic DATA_DIR
  try {
    if (fs && fs.existsSync(primaryPath)) {
      content = fs.readFileSync(primaryPath, 'utf-8');
    }
  } catch (err) {
    console.warn(`[dataStore] Primary read warning for ${primaryPath}:`, err);
  }

  // 3. Fallback to seed files (check data/ and .data/)
  if (!content || !content.trim()) {
    const seedCandidates = [
      path.join(process.cwd(), 'data', filename),
      path.join(process.cwd(), '.data', filename),
    ];
    for (const seedPath of seedCandidates) {
      try {
        if (fs && fs.existsSync(seedPath)) {
          content = fs.readFileSync(seedPath, 'utf-8');
          if (content && content.trim()) {
            // Prime primary directory safely
            try {
              const dir = path.dirname(primaryPath);
              safeMkdirSync(dir);
              if (fs) {
                fs.writeFileSync(primaryPath, content, 'utf-8');
              }
            } catch {}
            break;
          }
        }
      } catch (seedErr) {
        console.warn(`[dataStore] Seed read warning for ${seedPath}:`, seedErr);
      }
    }
  }

  // 4. Fallback to defaultContent
  if (!content || !content.trim()) {
    content = defaultContent;
  }

  // 5. Mirror into in-memory stores
  mem.set(filename, content);
  try {
    nemesis[filename] = JSON.parse(content);
  } catch {
    nemesis[filename] = content;
  }

  return content;
}

/**
 * Safely reads a data file asynchronously.
 */
export async function readDataFileAsync(filename: string, defaultContent: string = ''): Promise<string> {
  const nemesis = getNemesisMemoryStore();

  // 1. Fast in-memory hit from NEMESIS store
  if (filename in nemesis) {
    const val = nemesis[filename];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val;
    } else if (val !== undefined && val !== null) {
      return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
    }
  }

  const mem = getMemoryStore();
  if (mem.has(filename)) {
    const cached = mem.get(filename);
    if (cached !== undefined && cached.trim().length > 0) {
      return cached;
    }
  }

  const primaryPath = resolveDataFilePath(filename);
  let content: string | null = null;

  try {
    if (fs && fs.existsSync(primaryPath)) {
      content = await fs.promises.readFile(primaryPath, 'utf-8');
    }
  } catch (err) {
    console.warn(`[dataStore] Primary async read warning for ${primaryPath}:`, err);
  }

  if (!content || !content.trim()) {
    const seedCandidates = [
      path.join(process.cwd(), 'data', filename),
      path.join(process.cwd(), '.data', filename),
    ];
    for (const seedPath of seedCandidates) {
      try {
        if (fs && fs.existsSync(seedPath)) {
          content = await fs.promises.readFile(seedPath, 'utf-8');
          if (content && content.trim()) {
            try {
              const dir = path.dirname(primaryPath);
              safeMkdirSync(dir);
              if (fs) {
                await fs.promises.writeFile(primaryPath, content, 'utf-8');
              }
            } catch {}
            break;
          }
        }
      } catch (seedErr) {
        console.warn(`[dataStore] Seed async read warning for ${seedPath}:`, seedErr);
      }
    }
  }

  if (!content || !content.trim()) {
    content = defaultContent;
  }

  mem.set(filename, content);
  try {
    nemesis[filename] = JSON.parse(content);
  } catch {
    nemesis[filename] = content;
  }

  return content;
}

/**
 * Safely writes a data file synchronously.
 * Always updates globalThis.__NEMESIS_MEMORY_STORE__ and __QUANT_MEMORY_STORE__
 * so operations succeed 100% of the time even on read-only filesystems.
 */
export function writeDataFile(filename: string, content: string): boolean {
  const mem = getMemoryStore();
  mem.set(filename, content);

  const nemesis = getNemesisMemoryStore();
  try {
    nemesis[filename] = JSON.parse(content);
  } catch {
    nemesis[filename] = content;
  }

  const primaryPath = resolveDataFilePath(filename);
  try {
    const dir = path.dirname(primaryPath);
    safeMkdirSync(dir);
    if (fs) {
      fs.writeFileSync(primaryPath, content, 'utf-8');
    }
    return true;
  } catch (err) {
    console.warn(`[dataStore] File write warning for ${primaryPath} (falling back to memory):`, err);
    return false;
  }
}

/**
 * Safely writes a data file asynchronously with atomic temp rename where possible.
 * Always updates globalThis.__NEMESIS_MEMORY_STORE__ and __QUANT_MEMORY_STORE__
 * so operations succeed 100% of the time even on read-only filesystems.
 */
export async function writeDataFileAsync(filename: string, content: string): Promise<boolean> {
  const mem = getMemoryStore();
  mem.set(filename, content);

  const nemesis = getNemesisMemoryStore();
  try {
    nemesis[filename] = JSON.parse(content);
  } catch {
    nemesis[filename] = content;
  }

  const primaryPath = resolveDataFilePath(filename);
  try {
    const dir = path.dirname(primaryPath);
    safeMkdirSync(dir);

    const tmpPath = `${primaryPath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    if (fs) {
      await fs.promises.writeFile(tmpPath, content, 'utf-8');
      try {
        await fs.promises.rename(tmpPath, primaryPath);
      } catch {
        // Fallback to direct write if rename fails
        await fs.promises.writeFile(primaryPath, content, 'utf-8');
        try {
          if (fs.existsSync(tmpPath)) {
            await fs.promises.unlink(tmpPath);
          }
        } catch {}
      }
    }
    return true;
  } catch (err) {
    console.warn(`[dataStore] Async file write warning for ${primaryPath} (falling back to memory):`, err);
    return false;
  }
}
