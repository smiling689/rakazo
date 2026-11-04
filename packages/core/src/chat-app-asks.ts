import { isApprovalAskBlock, isSecretAskBlock } from "./action-approval.js";
import { resolveAskChoice } from "./answerable-ask.js";

/** The fields of a message's `ask` block that decide how a chat app shows and answers it. */
export type ChatAppAskBlock = {
  kind: string;
  text?: string;
  status?: string;
  input?: string;
  approvalEffectId?: string;
  instructionUpdate?: unknown;
  settingsUpdate?: unknown;
  actions?: Array<{ id: string; label: string }>;
};

const CJK = /[㐀-鿿豈-﫿]/;
const NUMBER_REPLY = /^\s*([1-9])\s*[.)、。)]?\s*$/;

/** An ask_user question: tappable options the user may also pick by replying in a chat app. */
export function isChoiceAskBlock(block: ChatAppAskBlock): boolean {
  return (
    block.kind === "ask" &&
    Boolean(block.actions?.length) &&
    !isApprovalAskBlock(block) &&
    !isSecretAskBlock(block) &&
    !block.instructionUpdate &&
    !block.settingsUpdate
  );
}

/**
 * How a still-pending ask reads in a 1:1 chat app, which cannot show cards. A choice lists its options by
 * number (a reply with the number or the option answers it, see chatAppAskChoice); approvals, secrets and
 * setting changes only say that the card waits in the app, so they are never answered by chat text.
 */
export function chatAppAskText(block: ChatAppAskBlock): string | undefined {
  if (block.kind !== "ask" || block.status === "answered") return undefined;
  const text = (block.text ?? "").trim();
  const zh = CJK.test(text);
  if (isChoiceAskBlock(block)) {
    const options = block.actions!.map((action, index) => `${index + 1}. ${action.label}`);
    return [text, ...options, zh ? "回复编号即可选择。" : "Reply with a number to choose."]
      .filter(Boolean)
      .join("\n");
  }
  const note = zh ? "(需要你在 App 里处理)" : "(This waits for you in the app.)";
  return text ? `${text}\n${note}` : note;
}

/** The option a chat-app reply picks for a pending choice: its number or its exact label, else nothing. */
export function chatAppAskChoice(
  block: ChatAppAskBlock,
  reply: string,
): { id: string; label: string } | undefined {
  if (!isChoiceAskBlock(block) || block.status === "answered") return undefined;
  const actions = block.actions!;
  const number = NUMBER_REPLY.exec(reply);
  if (number) return actions[Number(number[1]) - 1];
  return resolveAskChoice(reply, actions);
}
