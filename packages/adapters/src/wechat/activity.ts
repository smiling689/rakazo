import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IlinkMedia } from "./ilink-client.js";
import { loginKey } from "./state.js";

/** The picture a contact sent last, kept so a later reply can add it to the sticker collection. */
export interface WechatImageRef {
  media: IlinkMedia;
  aeskey?: string;
  at: number;
}

/**
 * Per-contact facts the two processes share through the data directory: the API process polls
 * and records the last picture a contact sent; whichever process delivers a reply records when
 * it did, so the poller can stop its typing indicator and skip its "on it" note. One small file
 * per contact and fact, written whole, so the processes never overwrite each other's data.
 */
export class WechatActivity {
  private readonly dir: string;

  constructor(dataDir: string, token: string) {
    this.dir = join(dataDir, "messaging", `wechat-${loginKey(token)}-activity`);
  }

  async markReplied(userId: string): Promise<void> {
    await this.write("replied", userId, { at: Date.now() });
  }

  async repliedSince(userId: string, since: number): Promise<boolean> {
    const replied = await this.read<{ at?: number }>("replied", userId);
    return (replied?.at ?? 0) >= since;
  }

  async rememberImage(userId: string, image: Omit<WechatImageRef, "at">): Promise<void> {
    await this.write("image", userId, { ...image, at: Date.now() });
  }

  async lastImage(userId: string, maxAgeMs: number): Promise<WechatImageRef | undefined> {
    const image = await this.read<WechatImageRef>("image", userId);
    return image?.media && Date.now() - image.at <= maxAgeMs ? image : undefined;
  }

  private path(kind: string, userId: string): string {
    const user = createHash("sha256").update(userId).digest("hex").slice(0, 16);
    return join(this.dir, `${kind}-${user}.json`);
  }

  private async write(kind: string, userId: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = this.path(kind, userId);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  }

  private async read<T>(kind: string, userId: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(kind, userId), "utf8")) as T;
    } catch {
      return undefined;
    }
  }
}
