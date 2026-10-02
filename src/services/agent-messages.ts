import { Types } from "mongoose";
import { pub } from "@/config/redis";
import { conversationModel } from "@/models/conversation";
import { messageModel, MessageType } from "@/models/message";
import { OrgChatUnavailableError, authorizeOrgChat, type OrgChatOrganization } from "@/services/org-chat-auth";
import { orgChatEnabled } from "@/services/org-chat";
import { logEvent } from "@/socket/auth";
import { parseAgentMessageBody } from "@/utils/agent-message";
import { idString } from "@/utils/ids";
import { isBlocked, orgChatError, organizationFields, organizationOf } from "@/utils/org-chat";

/**
 * Seemue AI cards in a chat (worktrees/AGENT-CONTRACT.md §8): POST
 * /agent-messages, seemuehub-backend only (X-Internal-Key, fail closed).
 *
 * Someone in a conversation asks Seemue AI for something there (an agreement
 * summary, a delivery checklist, a note); the backend posts the result here
 * as an AGENT message. It is stored as the requester's message (`sender` and
 * `actorUserId` are `requestedBy`), moves the conversation like any message,
 * and reaches sockets on SEND_MESSAGE like any message. It is never pushed.
 *
 * Who may ask:
 * - a participant of the conversation (both sides of an order chat, the
 *   candidate of a company conversation);
 * - in a company conversation, a member the backend lets SEND for that
 *   organization (ORG-CHAT-CONTRACT.md §2.2, the authorize the company
 *   routes use); their message carries `sendAsOrganizationId`, as a company
 *   message does. Needs ORG_CHAT_ENABLED, like every new company route.
 *
 * Nobody posts into a company conversation the candidate has blocked.
 */

/** A refusal the route answers as it is: an HTTP status and a code. */
export class AgentMessageRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AgentMessageRefusal";
  }
}

const refusal = (code: unknown) => {
  const { status, code: known, message } = orgChatError(code);
  return new AgentMessageRefusal(status, known, message);
};

const notFound = () => new AgentMessageRefusal(404, "CONVERSATION_NOT_FOUND", "Conversation not found");

/** The candidate's own words for a block (ORG-CHAT-CONTRACT.md §7.4); the company gets §5's. */
const blockedForCandidate = () => new AgentMessageRefusal(403, "ORG_CHAT_BLOCKED", "ທ່ານໄດ້ບລັອກບໍລິສັດນີ້ແລ້ວ");

/** What the checks and the fan-out read of the conversation. */
const CONVERSATION_FIELDS = "_id conversationType participants organizationId candidateUserId candidateBlockedAt";

type ConversationRow = {
  _id: unknown;
  participants?: { user?: unknown }[] | null;
  organizationId?: unknown;
  candidateUserId?: unknown;
  candidateBlockedAt?: unknown;
};

/** As the company, or as themselves: who the message is from. */
type Access = { asOrganizationId: string | null; organization: OrgChatOrganization | null };

const isParticipantOf = (conversation: ConversationRow, userId: string): boolean =>
  (conversation.participants ?? []).some((participant) => idString(participant?.user)?.toLowerCase() === userId);

/** May `requestedBy` post into `conversation`, and as whom? Throws the refusal. */
const accessFor = async (conversation: ConversationRow, requestedBy: string): Promise<Access> => {
  if (isParticipantOf(conversation, requestedBy)) {
    if (isBlocked(conversation)) throw blockedForCandidate();
    return { asOrganizationId: null, organization: null };
  }

  const organizationId = organizationOf(conversation);
  if (!organizationId) throw new AgentMessageRefusal(403, "NOT_PARTICIPANT", "requestedBy is not a participant of this conversation");
  if (!orgChatEnabled()) throw refusal("ORG_CHAT_DISABLED");

  let decision;
  try {
    decision = await authorizeOrgChat({ action: "SEND", organizationId, actorUserId: requestedBy });
  } catch (error) {
    // Fails closed: nothing is posted for a company on a guess.
    if (error instanceof OrgChatUnavailableError) throw refusal("ORG_CHAT_UNAVAILABLE");
    throw error;
  }
  if (!decision.allow) throw refusal(decision.code);
  if (isBlocked(conversation)) throw refusal("ORG_CHAT_BLOCKED");
  return { asOrganizationId: organizationId, organization: decision.organization };
};

/** The stored message as the route and the sockets hand it on: plain JSON. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * Validate, authorize, store, point the conversation at it, fan out. Resolves
 * to `{ message }`, the stored AGENT message; throws AgentMessageRefusal.
 */
export const postAgentMessage = async (body: unknown) => {
  const parsed = parseAgentMessageBody(body);
  if (!parsed.ok) throw new AgentMessageRefusal(400, "VALIDATION_ERROR", `${parsed.field} is invalid`);
  const { conversationId, requestedBy, content, agent } = parsed.value;

  const conversation = (await conversationModel
    .findOne({ _id: conversationId })
    .select(CONVERSATION_FIELDS)
    .lean()) as ConversationRow | null;
  if (!conversation) throw notFound();

  const { asOrganizationId, organization } = await accessFor(conversation, requestedBy);

  const sendAt = new Date();
  const created = await messageModel.create({
    _id: new Types.ObjectId(),
    sender: requestedBy,
    actorUserId: requestedBy,
    ...(asOrganizationId ? { sendAsOrganizationId: asOrganizationId } : {}),
    conversation: conversation._id,
    messageType: MessageType.AGENT,
    content,
    agent: { ...agent, requestedBy: new Types.ObjectId(requestedBy) },
    fileUploaded: true,
    sendAt,
  });
  const message = plain(typeof (created as any).toObject === "function" ? (created as any).toObject() : created);

  // The list shows `content`, as it shows any message's: old clients read it
  // as the requester's text.
  const latestMessageData = {
    senderId: requestedBy,
    messageId: String(message._id),
    messageType: MessageType.AGENT,
    content,
    sendAt,
    readAllAt: null,
    isDeleted: false,
  };
  // An update, never .save() (CHAT-CONTRACT.md §1.1). Timestamps stay on: a
  // new message moves the conversation to the top, this one too. A block
  // that lands between the check and here is honoured (the message goes).
  const company = organizationOf(conversation);
  const updated = await conversationModel.updateOne(
    { _id: conversation._id, ...(company ? { candidateBlockedAt: null } : {}) },
    { $set: { latestMessageData, ...(asOrganizationId ? organizationFields(organization) : {}) } }
  );
  if (updated.matchedCount === 0) {
    await messageModel.deleteOne({ _id: message._id }).catch(() => {});
    if (!company) throw notFound();
    throw asOrganizationId ? refusal("ORG_CHAT_BLOCKED") : blockedForCandidate();
  }

  // Delivered like any message: every participant's room, the conversation's
  // page room and, for a company conversation, its org:{orgId} room
  // (socket/rooms.ts deliverNewMessage). No push (§8.2).
  await pub.publish(
    "SEND_MESSAGE",
    JSON.stringify({ conversation: { ...plain(conversation), latestMessageData: plain(latestMessageData) }, messageData: message })
  );

  logEvent({
    msg: "agent_message_posted",
    conversationId,
    messageId: String(message._id),
    requestedBy,
    kind: agent.kind,
    cardType: agent.card.type,
    asOrganizationId,
  });
  return { message };
};
