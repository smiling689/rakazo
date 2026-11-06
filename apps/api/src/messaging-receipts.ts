import { randomUUID } from "node:crypto";
import type { MessagingReceipt, MessagingSurface } from "@rakazo/adapter-kit";
import { providerOfThreadId } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";

// A reaction stays on the message, so it only goes on a late one: a fast reply
// is its own acknowledgement.
const RECEIPT_DELAY_MS: Record<MessagingReceipt, number> = {
  typing: 0,
  reaction: 60_000,
};

const RECEIPT_TIMEOUT_MS = 2000;

/**
 * A refreshed typing indicator stops once the reply is out or the run has ended without one.
 * This only bounds a run that never reports either (a worker that stopped mid-run).
 */
export const TYPING_REFRESH_MAX_MS = 30 * 60_000;

export interface MessagingReceipts {
  acknowledge(threadId: string, handle: string, handled: () => Promise<boolean>): void;
  stop(): void;
}

export function createMessagingReceipts(
  messaging: Pick<MessagingSurface, "platforms" | "acknowledge">,
): MessagingReceipts {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /** The typing refresh running in each conversation; a newer message's replaces it. */
  const typing = new Map<string, () => void>();
  let stopped = false;

  const send = async (threadId: string, handle: string): Promise<void> => {
    const operationId = `messaging.acknowledge:${randomUUID()}`;
    await messaging.acknowledge(threadId, handle, {
      operationId,
      traceId: operationId,
      spaceId: "",
      userId: "",
      signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
    });
  };
  const logFailure = (error: unknown) => getLogger().error("messaging receipt error", error);

  /**
   * Keeps typing showing while the run works, including after an interim message (which
   * clears it on the platform), until the reply is out or the run has ended.
   */
  const keepTyping = (
    threadId: string,
    handle: string,
    handled: () => Promise<boolean>,
    everyMs: number,
  ) => {
    typing.get(threadId)?.();
    const since = Date.now();
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      (async () => {
        if (stopped || Date.now() - since >= TYPING_REFRESH_MAX_MS || (await handled())) {
          stop();
          return;
        }
        await send(threadId, handle);
      })()
        .catch(logFailure)
        .finally(() => {
          busy = false;
        });
    }, everyMs);
    timer.unref?.();
    const stop = () => {
      clearInterval(timer);
      if (typing.get(threadId) === stop) typing.delete(threadId);
    };
    typing.set(threadId, stop);
  };

  return {
    acknowledge(threadId, handle, handled) {
      if (stopped) return;
      const provider = providerOfThreadId(threadId);
      const capabilities = messaging
        .platforms()
        .find((platform) => platform.provider === provider)?.capabilities;
      const receipt = capabilities?.receipt;
      if (!receipt) return;
      const delay = RECEIPT_DELAY_MS[receipt];
      if (delay <= 0) {
        send(threadId, handle).catch(logFailure);
        if (receipt === "typing" && capabilities.typingRefreshMs) {
          keepTyping(threadId, handle, handled, capabilities.typingRefreshMs);
        }
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        (async () => {
          if ((await handled()) || stopped) return;
          await send(threadId, handle);
        })().catch(logFailure);
      }, delay);
      timer.unref?.();
      timers.add(timer);
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const stopTyping of [...typing.values()]) stopTyping();
    },
  };
}
