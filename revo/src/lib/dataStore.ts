/**
 * Shared Dynamic Data Store & Writable Filesystem Fallback (src/lib/dataStore.ts)
 * Resolves data directory dynamically:
 * - On Vercel / serverless: '/tmp/quant-data'
 * - Locally / standard Node.js: path.join(process.cwd(), 'data')
 *
 * Guaranteed zero EROFS runtime crashes:
 * - Initial seed file loading from path.join(process.cwd(), 'data', filename)
 * - In-memory fallback map (globalThis.__QUANT_MEMORY_STORE__)
 * - All fs operations (mkdirSync, readFileSync, writeFileSync, etc.) wrapped in safe try/catch blocks
 */

const fs = typeof window === "undefined" ? eval("require")("fs") : null;
const path = typeof window === "undefined" ? eval("require")("path") : null;

declare global {
  // eslint-disable-next-line no-var
  var __QUANT_MEMORY_STORE__: Map<string, string> | undefined;
}

export function getMemoryStore(): Map<string, string> {
  if (!globalThis.__QUANT_MEMORY_STORE__) {
    globalThis.__QUANT_MEMORY_STORE__ = new Map<string, string>();
  }
  return globalThis.__QUANT_MEMORY_STORE__;
}

/**
 * Returns dynamic data directory path
 */
export function getDataDir(): string {
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }
  return process.env.VERCEL ? '/tmp/quant-data' : path.join(process.cwd(), 'data');
}

/**
 * Resolves absolute path to a file inside dynamic DATA_DIR
 */
export function resolveDataFilePath(filename: string): string {
  return path.join(getDataDir(), filename);
}

/**
 * Resolves absolute path to the initial seed file inside project root /data
 */
export function getSeedFilePath(filename: string): string {
  return path.join(process.cwd(), 'data', filename);
}

/**
 * Safely ensures directory exists without throwing EROFS
 */
export function safeMkdirSync(dirPath: string): boolean {
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
 * Safely reads a data file.
 * 1. Checks in-memory store (globalThis.__QUANT_MEMORY_STORE__) first if already populated
 * 2. Checks dynamic DATA_DIR (e.g. /tmp/quant-data/filename)
 * 3. Falls back to project seed file (path.join(process.cwd(), 'data', filename))
 * 4. Falls back to defaultContent
 * 5. Updates in-memory store and attempts to prime /tmp
 */
export function readDataFile(filename: string, defaultContent: string = ''): string {
  const mem = getMemoryStore();

  // If in-memory store already has an updated version for this process, return it
  if (mem.has(filename)) {
    const cached = mem.get(filename);
    if (cached !== undefined && cached.trim().length > 0) {
      return cached;
    }
  }

  const primaryPath = resolveDataFilePath(filename);
  let content: string | null = null;

  // 1. Try reading from dynamic DATA_DIR
  try {
    if (fs.existsSync(primaryPath)) {
      content = fs.readFileSync(primaryPath, 'utf-8');
    }
  } catch (err) {
    console.warn(`[dataStore] Primary read warning for ${primaryPath}:`, err);
  }

  // 2. If not found in DATA_DIR, try reading seed file
  if (!content || !content.trim()) {
    const seedPath = getSeedFilePath(filename);
    try {
      if (fs.existsSync(seedPath)) {
        content = fs.readFileSync(seedPath, 'utf-8');
        // Try writing seed content to DATA_DIR so subsequent reads hit /tmp
        try {
          const dir = path.dirname(primaryPath);
          safeMkdirSync(dir);
          fs.writeFileSync(primaryPath, content, 'utf-8');
        } catch {
          // Ignore if DATA_DIR write fails (e.g. read-only filesystem)
        }
      }
    } catch (seedErr) {
      console.warn(`[dataStore] Seed read warning for ${seedPath}:`, seedErr);
    }
  }

  // 3. Fallback to defaultContent
  if (!content || !content.trim()) {
    content = defaultContent;
  }

  // 4. Update memory store
  mem.set(filename, content);
  return content;
}

/**
 * Safely reads a data file asynchronously.
 */
export async function readDataFileAsync(filename: string, defaultContent: string = ''): Promise<string> {
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
    if (fs.existsSync(primaryPath)) {
      content = await fs.promises.readFile(primaryPath, 'utf-8');
    }
  } catch (err) {
    console.warn(`[dataStore] Primary async read warning for ${primaryPath}:`, err);
  }

  if (!content || !content.trim()) {
    const seedPath = getSeedFilePath(filename);
    try {
      if (fs.existsSync(seedPath)) {
        content = await fs.promises.readFile(seedPath, 'utf-8');
        try {
          const dir = path.dirname(primaryPath);
          safeMkdirSync(dir);
          await fs.promises.writeFile(primaryPath, content, 'utf-8');
        } catch {
          // Ignore
        }
      }
    } catch (seedErr) {
      console.warn(`[dataStore] Seed async read warning for ${seedPath}:`, seedErr);
    }
  }

  if (!content || !content.trim()) {
    content = defaultContent;
  }

  mem.set(filename, content);
  return content;
}

/**
 * Safely writes a data file synchronously.
 * Always updates globalThis.__QUANT_MEMORY_STORE__ so operations never fail.
 */
export function writeDataFile(filename: string, content: string): boolean {
  const mem = getMemoryStore();
  mem.set(filename, content);

  const primaryPath = resolveDataFilePath(filename);
  try {
    const dir = path.dirname(primaryPath);
    safeMkdirSync(dir);
    fs.writeFileSync(primaryPath, content, 'utf-8');
    return true;
  } catch (err) {
    console.warn(`[dataStore] File write warning for ${primaryPath} (falling back to memory):`, err);
    return false;
  }
}

/**
 * Safely writes a data file asynchronously with atomic rename where possible.
 * Always updates globalThis.__QUANT_MEMORY_STORE__ so operations never fail.
 */
export async function writeDataFileAsync(filename: string, content: string): Promise<boolean> {
  const mem = getMemoryStore();
  mem.set(filename, content);

  const primaryPath = resolveDataFilePath(filename);
  try {
    const dir = path.dirname(primaryPath);
    safeMkdirSync(dir);

    const tmpPath = `${primaryPath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await fs.promises.writeFile(tmpPath, content, 'utf-8');
    try {
      await fs.promises.rename(tmpPath, primaryPath);
    } catch {
      // In case rename fails (e.g. cross-filesystem or lock), write directly
      await fs.promises.writeFile(primaryPath, content, 'utf-8');
      try {
        if (fs.existsSync(tmpPath)) {
          await fs.promises.unlink(tmpPath);
        }
      } catch {}
    }
    return true;
  } catch (err) {
    console.warn(`[dataStore] Async file write warning for ${primaryPath} (falling back to memory):`, err);
    return false;
  }
}
