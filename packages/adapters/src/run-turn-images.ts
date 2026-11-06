import type { AgentRunRequest, AgentSteeringMessage } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, isAttachmentImageMimeType } from "@rakazo/contracts";
import { blocksToAgentHistoryText } from "@rakazo/core";
import type { ExecutorDeps } from "./executor-deps.js";
import { loadReplyContext } from "./reply-context.js";
import { currentTurnFilesInstruction, listCurrentTurnFiles } from "./thread-artifacts.js";

const TURN_ATTACHMENT_UNAVAILABLE =
  "An attachment in this message could not be loaded. Tell the user the attachment was unavailable and do not guess its contents.";

const STEERING_ATTACHMENT_UNAVAILABLE = TURN_ATTACHMENT_UNAVAILABLE;

export function missingTurnImagesInstruction(
  blocks: MessageBlock[] | undefined,
  images: { length: number } | undefined,
): string {
  const expected = blocks?.filter((block) => block.kind === "image").length ?? 0;
  const loaded = images?.length ?? 0;
  return expected > 0 && loaded < expected ? TURN_ATTACHMENT_UNAVAILABLE : "";
}

export async function settleSteeringAttachmentLoads<TImage, TFile>(
  images: Promise<TImage[] | undefined>,
  files: Promise<TFile[]>,
  blocks?: MessageBlock[],
  signal?: AbortSignal,
): Promise<{
  images: TImage[] | undefined;
  files: TFile[];
  unavailableInstruction: string;
}> {
  const [loadedImages, loadedFiles] = await Promise.allSettled([images, files]);
  if (signal?.aborted) {
    if (loadedImages.status === "rejected") throw loadedImages.reason;
    if (loadedFiles.status === "rejected") throw loadedFiles.reason;
  }
  const expectedImageCount = blocks?.filter((block) => block.kind === "image").length ?? 0;
  const loadedImageCount =
    loadedImages.status === "fulfilled" ? (loadedImages.value?.length ?? 0) : 0;
  const unavailable =
    loadedImages.status === "rejected" ||
    loadedFiles.status === "rejected" ||
    loadedImageCount < expectedImageCount;
  return {
    images: loadedImages.status === "fulfilled" ? loadedImages.value : undefined,
    files: loadedFiles.status === "fulfilled" ? loadedFiles.value : [],
    unavailableInstruction: unavailable ? STEERING_ATTACHMENT_UNAVAILABLE : "",
  };
}

export async function loadCurrentTurnImages(
  deps: ExecutorDeps,
  blocks: MessageBlock[] | undefined,
  context: {
    operationId: string;
    traceId: string;
    spaceId: string;
    userId: string;
    botId: string;
    runId: string;
    signal: AbortSignal;
  },
) {
  if (!deps.artifacts || !blocks?.length) return undefined;
  const imageBlocks = blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "image" }> => block.kind === "image",
  );
  if (!imageBlocks.length) return undefined;

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: imageBlocks.map((block) => block.artifactId) },
      spaceId: context.spaceId,
      userId: context.userId,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const images: NonNullable<AgentRunRequest["currentTurnImages"]> = [];

  for (const block of imageBlocks) {
    const row = byId.get(block.artifactId);
    if (!row || !isAttachmentImageMimeType(block.mimeType)) continue;
    try {
      const bytes = await deps.artifacts.get(row.storageKey, context);
      images.push({
        name: block.name,
        mimeType: block.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
        data: bytes,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
    }
  }

  return images.length ? images : undefined;
}

/** Recent user turns whose attachments are offered to the computer. */
export const RECENT_TURN_IMAGE_TURNS = 3;

/** Most user turns with pictures in one prompt, the current turn included. */
export const TURN_IMAGE_WINDOW_TURNS = 5;

/** Total image bytes in one prompt's window, matching the per-attachment ceiling. */
export const RECENT_TURN_IMAGE_BYTES = ATTACHMENT_MAX_BYTES;

function declaredArtifactBytes(size: unknown): number | undefined {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return undefined;
  return size;
}

type ImageWindowLimits = { turns: number; images: number; bytes: number };

/**
 * Index of the oldest image still sent, for images in prompt order (`turn` groups one message's).
 *
 * A window of the newest images would turn one older message back into text on every new
 * picture, rewriting the cached prompt from there on. Instead the start stays put until the
 * images after it break a limit, then jumps forward to the newest that fit half of every limit,
 * so the prompt is rewritten about once per several pictures. It is replayed from the first
 * image, so consecutive turns of a thread agree without storing anything.
 */
export function imageWindowStart(
  slots: readonly { turn: number; bytes: number }[],
  limits: ImageWindowLimits,
): number {
  const half: ImageWindowLimits = {
    turns: Math.ceil(limits.turns / 2),
    images: Math.ceil(limits.images / 2),
    bytes: Math.ceil(limits.bytes / 2),
  };
  const fits = (from: number, to: number, cap: ImageWindowLimits) => {
    let turns = 0;
    let bytes = 0;
    for (let index = from; index <= to; index += 1) {
      const slot = slots[index]!;
      if (index === from || slot.turn !== slots[index - 1]!.turn) turns += 1;
      bytes += slot.bytes;
    }
    return turns <= cap.turns && to - from + 1 <= cap.images && bytes <= cap.bytes;
  };
  let start = 0;
  for (let end = 0; end < slots.length; end += 1) {
    if (fits(start, end, limits)) continue;
    // The newest image always stays; older ones join while half of each limit holds.
    start = end;
    while (start > 0 && fits(start - 1, end, half)) start -= 1;
  }
  return start;
}

function unavailableImageMarker(name: string): string {
  return `[image: ${name} (unavailable)]`;
}

/** Replace image markers in attachment order, starting at `cursor`. */
function rewriteImageMarkersInOrder(
  content: string,
  outcomes: readonly { name: string; unavailable: boolean }[],
): string {
  let cursor = 0;
  let next = "";
  for (const outcome of outcomes) {
    const marker = `[image: ${outcome.name}]`;
    const at = content.indexOf(marker, cursor);
    if (at < 0) continue;
    const replacement = outcome.unavailable ? unavailableImageMarker(outcome.name) : marker;
    next += content.slice(cursor, at) + replacement;
    cursor = at + marker.length;
  }
  return next + content.slice(cursor);
}

/**
 * Replace image markers from the end, one per attachment.
 * A leading quote of the same name is left alone.
 */
function rewriteImageMarkersFromEnd(
  content: string,
  outcomes: readonly { name: string; unavailable: boolean }[],
): string {
  let end = content.length;
  const parts: string[] = [];
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    const outcome = outcomes[index];
    if (!outcome) continue;
    const marker = `[image: ${outcome.name}]`;
    const at = content.lastIndexOf(marker, Math.max(0, end - 1));
    if (at < 0 || at + marker.length > end) continue;
    const replacement = outcome.unavailable ? unavailableImageMarker(outcome.name) : marker;
    parts.push(content.slice(at + marker.length, end), replacement);
    end = at;
  }
  parts.push(content.slice(0, end));
  return parts.reverse().join("");
}

/**
 * Rewrite the markers attachment rendering appended for this message.
 * A quoted `[image: name]` earlier in the text is not this message's attachment.
 */
function markUnavailableHistoryImages(
  content: string,
  blocks: MessageBlock[],
  outcomes: readonly { name: string; unavailable: boolean }[],
): string {
  const rendered = blocksToAgentHistoryText(blocks);
  const suffixAt = rendered.length > 0 ? content.lastIndexOf(rendered) : -1;
  if (suffixAt >= 0) {
    const suffixEnd = suffixAt + rendered.length;
    return (
      content.slice(0, suffixAt) +
      rewriteImageMarkersInOrder(content.slice(suffixAt, suffixEnd), outcomes) +
      content.slice(suffixEnd)
    );
  }
  return rewriteImageMarkersFromEnd(content, outcomes);
}

/**
 * Hydrate the images of recent user turns in the run history.
 *
 * Earlier turns reached the model only as an `[image: name]` marker, so a question asked one
 * turn after the upload had nothing to look at. Which images are sent comes from
 * `imageWindowStart` over every image in the history, the current turn's included, so the window
 * holds the prompt's image limit (`maxImages`), the byte ceiling, and `maxTurns` image turns. An
 * image larger than the ceiling is never sent. Bytes are read through the same artifact path and
 * space/user scope as the current turn; one that cannot be read is marked unavailable.
 */
export async function withRecentTurnImages(
  deps: ExecutorDeps,
  history: AgentRunRequest["history"],
  messages: Array<{ id: string; blocks: MessageBlock[] }>,
  context: {
    operationId: string;
    traceId: string;
    spaceId: string;
    userId: string;
    botId: string;
    runId: string;
    signal: AbortSignal;
  },
  options: {
    /** The current turn: its images count toward the window but are sent with the prompt. */
    skipMessageId?: string | null;
    maxTurns?: number;
    maxBytes?: number;
    /** The model's image limit for the whole prompt, the current turn's images included. */
    maxImages?: number;
  } = {},
): Promise<AgentRunRequest["history"]> {
  const artifacts = deps.artifacts;
  if (!artifacts) return history;
  const limits: ImageWindowLimits = {
    turns: options.maxTurns ?? TURN_IMAGE_WINDOW_TURNS,
    images: options.maxImages ?? Number.POSITIVE_INFINITY,
    bytes: options.maxBytes ?? RECENT_TURN_IMAGE_BYTES,
  };
  if (limits.turns <= 0 || limits.images <= 0 || limits.bytes <= 0) return history;
  const blocksByMessageId = new Map(messages.map((message) => [message.id, message.blocks]));
  const imageBlocksOf = (blocks: MessageBlock[] | undefined) =>
    (blocks ?? []).filter(
      (block): block is Extract<MessageBlock, { kind: "image" }> => block.kind === "image",
    );
  const turns: Array<{
    entry?: AgentRunRequest["history"][number];
    blocks: MessageBlock[];
    images: Array<Extract<MessageBlock, { kind: "image" }>>;
  }> = [];
  let currentInHistory = false;
  for (const entry of history) {
    if (!entry.id || entry.role !== "user") continue;
    const blocks = blocksByMessageId.get(entry.id) ?? [];
    const images = imageBlocksOf(blocks);
    if (images.length === 0) continue;
    const current = entry.id === options.skipMessageId;
    currentInHistory ||= current;
    turns.push({ ...(current ? {} : { entry }), blocks, images });
  }
  if (options.skipMessageId && !currentInHistory) {
    const blocks = blocksByMessageId.get(options.skipMessageId) ?? [];
    const images = imageBlocksOf(blocks);
    if (images.length > 0) turns.push({ blocks, images });
  }
  if (!turns.some((turn) => turn.entry)) return history;

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: turns.flatMap((turn) => turn.images.map((block) => block.artifactId)) },
      spaceId: context.spaceId,
      userId: context.userId,
    },
    select: { id: true, storageKey: true, size: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  // A missing artifact holds its slot so a deleted file does not move the window. Stored sizes
  // decide the window, so nothing outside it is read.
  const slots = turns.flatMap((turn, turnIndex) =>
    turn.images.flatMap((block, blockIndex) => {
      if (!isAttachmentImageMimeType(block.mimeType)) return [];
      const row = byId.get(block.artifactId);
      const bytes = row ? declaredArtifactBytes(row.size) : 0;
      if (bytes === undefined || bytes > limits.bytes) return [];
      return [{ turn: turnIndex, blockIndex, bytes, row }];
    }),
  );
  const window = slots.slice(imageWindowStart(slots, limits));

  const hydrated = new Map<
    string,
    { images?: NonNullable<AgentRunRequest["currentTurnImages"]>; content?: string }
  >();
  await Promise.all(
    turns.map(async (turn, turnIndex) => {
      const entry = turn.entry;
      const sent = window.filter((slot) => slot.turn === turnIndex);
      if (!entry?.id || sent.length === 0) return;
      const unavailable = new Set<number>();
      const loaded = await Promise.all(
        sent.map(async (slot) => {
          const block = turn.images[slot.blockIndex]!;
          if (!slot.row) {
            unavailable.add(slot.blockIndex);
            return [];
          }
          let bytes: Uint8Array;
          try {
            bytes = await artifacts.get(slot.row.storageKey, context);
          } catch (error) {
            if (context.signal.aborted) throw error;
            unavailable.add(slot.blockIndex);
            return [];
          }
          // The window was sized from the stored size; never send more than it promised.
          if (bytes.byteLength > slot.bytes) return [];
          return [
            {
              name: block.name,
              mimeType: block.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
              data: bytes,
            },
          ];
        }),
      );
      const images = loaded.flat();
      const outcomes = turn.images.map((block, index) => ({
        name: block.name,
        unavailable: unavailable.has(index),
      }));
      const content =
        unavailable.size > 0
          ? markUnavailableHistoryImages(entry.content, turn.blocks, outcomes)
          : entry.content;
      if (images.length > 0 || content !== entry.content) {
        hydrated.set(entry.id, {
          ...(images.length > 0 ? { images } : {}),
          ...(content !== entry.content ? { content } : {}),
        });
      }
    }),
  );

  if (hydrated.size === 0) return history;
  return history.map((entry) => {
    const update = entry.id ? hydrated.get(entry.id) : undefined;
    if (!update) return entry;
    return {
      ...entry,
      ...(update.content !== undefined ? { content: update.content } : {}),
      ...(update.images ? { images: update.images } : {}),
    };
  });
}

/**
 * Claims messages the user sent while the run was working and loads their attachments. Each
 * message that brought files queues them for the computer.
 */
export async function claimRunSteering(
  deps: ExecutorDeps,
  lease: { threadId: string; botId: string; runId: string; leaseOwner: string; leaseFence: number },
  seenIds: string[],
  context: Parameters<typeof loadCurrentTurnImages>[2],
  pendingTurnFiles: MessageBlock[][],
  currentTurn: { messageId?: string; hasImages: boolean },
): Promise<AgentSteeringMessage[]> {
  const steering = await deps.events.claimSteering({ ...lease, seenIds });
  return Promise.all(
    steering.map(async (item) => {
      const { images, files, unavailableInstruction } = await settleSteeringAttachmentLoads(
        loadCurrentTurnImages(deps, item.blocks, context),
        deps.artifacts ? listCurrentTurnFiles(deps, item.blocks, context) : Promise.resolve([]),
        item.blocks,
        context.signal,
      );
      if (files.length) pendingTurnFiles.push(item.blocks);
      const filesInstruction = currentTurnFilesInstruction(files);
      return {
        id: item.id,
        messageId: item.messageId,
        origin: item.origin,
        historyText: item.text,
        text: [
          await loadReplyContext(deps.prisma, lease.threadId, item.messageId),
          item.text,
          filesInstruction,
          unavailableInstruction,
        ]
          .filter(Boolean)
          .join("\n\n"),
        // A legacy run without sourceMessageId may resolve this same
        // message as its current turn. Its images are already supplied.
        images:
          item.messageId === currentTurn.messageId && currentTurn.hasImages ? undefined : images,
        imageFileFallback: Boolean(
          images?.length &&
            files.length &&
            !item.blocks.some(
              (block) => block.kind === "image" && block.imageHandling === "confirm",
            ),
        ),
      };
    }),
  );
}
