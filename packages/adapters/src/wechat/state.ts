import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface StoredState {
  cursor?: string;
  /** Latest reply context per contact; iLink wants it on every message to that contact. */
  contexts?: Record<string, string>;
}

/**
 * Small file-backed state for one bot login: the long-poll cursor, so a
 * restart neither replays nor skips messages, and each contact's latest reply
 * context. The polling process writes it; any process that sends (the worker
 * delivering a routine's result) reads it, so it lives in the shared data
 * directory. Keyed by a hash of the token: a new login starts clean.
 */
export class WechatStateStore {
  private readonly path: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string, token: string) {
    const key = createHash("sha256").update(token).digest("hex").slice(0, 16);
    this.path = join(dataDir, "messaging", `wechat-${key}.json`);
  }

  async cursor(): Promise<string> {
    return (await this.read()).cursor ?? "";
  }

  async context(userId: string): Promise<string | undefined> {
    return (await this.read()).contexts?.[userId];
  }

  /** Records the cursor and any contexts the batch carried, in one write. */
  async update(cursor: string, contexts: Record<string, string>): Promise<void> {
    const next = this.writing.then(async () => {
      const state = await this.read();
      state.cursor = cursor;
      state.contexts = { ...state.contexts, ...contexts };
      await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.writing = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<StoredState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return typeof parsed === "object" && parsed !== null ? (parsed as StoredState) : {};
    } catch {
      return {};
    }
  }
}
