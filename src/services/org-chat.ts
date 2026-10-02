import { Types } from "mongoose";
import { env } from "@/config/env";
import { cache, pub } from "@/config/redis";
import { resolveReply } from "@/controllers/message/reply";
import { conversationModel } from "@/models/conversation";
import { messageModel, MessageType } from "@/models/message";
import { findActiveMembership, organizationMemberModel } from "@/models/organization-member";
import { pushChatMessage } from "@/services/chat-push";
import {
  OrgChatUnavailableError,
  authorizeOrgChat,
  reportBlock,
  reportOpened,
  type OrgChatAction,
  type OrgChatOrganization,
} from "@/services/org-chat-auth";
import { orgRoomOf } from "@/socket/rooms";
import { logEvent } from "@/socket/auth";
import { idString, isObjectIdString } from "@/utils/ids";
import { isClientMessageType } from "@/utils/message-type";
import {
  candidateOf,
  isBlocked,
  orgChatError,
  organizationFields,
  organizationOf,
  orgUnread,
  parseOpenBody,
} from "@/utils/org-chat";
import { participantOf } from "@/utils/conversation-access";
import { checkSticker } from "@/utils/sticker";

/**
 * Company ↔ candidate chat (worktrees/ORG-CHAT-CONTRACT.md §3).
 *
 * A company conversation has one participant, the candidate; the
 * organization's members are never added to it. They reach it through the
 * /organizations routes, which ask seemuehub-backend whether this member may
 * open, list, read or answer for this organization (services/org-chat-auth.ts),
 * and their messages carry `sendAsOrganizationId` (who typed it is
 * `actorUserId`, never shown to the candidate). Sockets hear it in the
 * candidate's room and in the organization's `org:{orgId}` room.
 *
 * Every conversation write here is an update, never a `.save()`
 * (CHAT-CONTRACT.md §1.1): a read must not move the chat to the top of the
 * list, so those run with `timestamps: false`; a message does move it.
 *
 * ORG_CHAT_ENABLED off: opening answers 403 ORG_CHAT_DISABLED, the routes that
 * are new answer it too, and the ones that already existed (the company list
 * and the company send) keep their old rule, an ACTIVE membership, with no
 * fan-out and no push, as before.
 */

export const orgChatEnabled = () => env.ORG_CHAT_ENABLED === "true";

/** A refusal the routes answer as it is: an HTTP status and a code. */
export class OrgChatRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "OrgChatRefusal";
  }
}

const refusal = (code: unknown) => {
  const { status, code: known, message } = orgChatError(code);
  return new OrgChatRefusal(status, known, message);
};

const disabled = () => refusal("ORG_CHAT_DISABLED");

/** The organization a member acts for, as far as this send or read needs it. */
type MemberAccess = { organization: OrgChatOrganization | null };

/**
 * May `actorUserId` do `action` for the organization? With the switch on, the
 * backend decides (cached 60 s for LIST, READ and SEND); unreachable is a 503,
 * never a yes. With it off, the rule these routes always had: an ACTIVE
 * membership, any role.
 *
 * `hideNotMember` answers a non-member 404 CONVERSATION_NOT_FOUND, for the
 * routes addressed by conversation id: whether an id is some company's
 * conversation is not a stranger's to learn (utils/conversation-access.ts).
 */
export const requireMember = async (
  organizationId: string,
  actorUserId: string,
  action: Exclude<OrgChatAction, "OPEN">,
  { hideNotMember = false } = {}
): Promise<MemberAccess> => {
  if (!orgChatEnabled()) {
    if (await findActiveMembership(organizationId, actorUserId)) return { organization: null };
    throw new OrgChatRefusal(403, "ORGANIZATION_MEMBERSHIP_REQUIRED", "Active organization membership is required");
  }

  let decision;
  try {
    decision = await authorizeOrgChat({ action, organizationId, actorUserId });
  } catch (error) {
    if (error instanceof OrgChatUnavailableError) throw refusal("ORG_CHAT_UNAVAILABLE");
    throw error;
  }
  if (!decision.allow) {
    if (hideNotMember && decision.code === "ORG_CHAT_NOT_MEMBER") {
      throw new OrgChatRefusal(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
    }
    throw refusal(decision.code);
  }
  return { organization: decision.organization };
};

/** The stored message as the socket and the routes hand it on: plain JSON. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * The fan-out of a stored message in a company conversation: SEND_MESSAGE
 * (the candidate's room and `org:{orgId}`, config/redis.ts), then the push
 * (services/chat-push.ts decides who: the candidate for a company message,
 * the company for the candidate's). Only with the switch on; never throws.
 */
export const announceOrgMessage = (conversation: unknown, message: unknown): void => {
  if (!orgChatEnabled() || !conversation || !message) return;
  try {
    void pub.publish("SEND_MESSAGE", JSON.stringify({ conversation, messageData: message }));
    void pushChatMessage(conversation as any, message as any);
  } catch (error) {
    console.error("org message fan-out failed", error instanceof Error ? error.message : error);
  }
};

/** What a company message may carry: the TEXT and STICKER rules of the routes before this. */
export interface CompanyMessageInput {
  body?: unknown;
  content?: unknown;
  messageType?: unknown;
  attachments?: unknown;
  replyTo?: unknown;
}

/** A company message's stored fields, or why it is refused (a 400). */
const companyContent = (input: CompanyMessageInput): { ok: true; fields: Record<string, unknown> } | { ok: false; code: "INVALID_MESSAGE_TYPE" | "INVALID_STICKER" | "VALIDATION_ERROR" } => {
  // Stored as TEXT; a server-only type (SYSTEM, ORDER_*) is refused, not downgraded.
  if (input.messageType !== undefined && !isClientMessageType(input.messageType)) return { ok: false, code: "INVALID_MESSAGE_TYPE" };
  if (input.messageType === MessageType.STICKER) {
    const sticker = checkSticker(input.attachments, env.STICKER_URL_PREFIX);
    if (!sticker.ok) return { ok: false, code: "INVALID_STICKER" };
    return {
      ok: true,
      fields: { content: sticker.content, messageType: MessageType.STICKER, attachments: sticker.attachments, fileUploaded: true },
    };
  }
  const content = input.body ?? input.content;
  // An empty company message would reach the candidate as a blank bubble and push.
  if (typeof content !== "string" || content.trim() === "") return { ok: false, code: "VALIDATION_ERROR" };
  return { ok: true, fields: { content, messageType: MessageType.TEXT } };
};

/** The latestMessageData of a newly stored message. */
const latestOf = (message: { _id: unknown; messageType?: unknown; content?: unknown; sendAt?: unknown }, senderId: string) => ({
  senderId,
  messageId: String(message._id),
  messageType: message.messageType,
  content: message.content,
  sendAt: message.sendAt,
  readAllAt: null,
  isDeleted: false,
});

/**
 * Store one company message in `conversation` and point the conversation at
 * it. Refused when the candidate has blocked the company, including a block
 * that lands between the check and the write (the message is then removed
 * again). The organization snapshot, `conversationName` and
 * `conversationImage` are refreshed from `organization` when there is one.
 */
export const storeCompanyMessage = async (
  conversation: { _id: unknown; organizationId?: unknown; candidateBlockedAt?: unknown },
  actorUserId: string,
  organization: OrgChatOrganization | null,
  input: CompanyMessageInput,
  messageId: Types.ObjectId = new Types.ObjectId()
) => {
  if (isBlocked(conversation)) throw refusal("ORG_CHAT_BLOCKED");
  const content = companyContent(input);
  if (!content.ok) {
    throw new OrgChatRefusal(400, content.code, content.code === "VALIDATION_ERROR" ? "Message text is required" : "Invalid message");
  }

  const reply = await resolveReply(input.replyTo, conversation._id, null, { event: "ORG_MESSAGE", userId: actorUserId });
  const sendAt = new Date();
  const message = await messageModel.create({
    _id: messageId,
    sender: actorUserId,
    actorUserId,
    sendAsOrganizationId: conversation.organizationId,
    conversation: conversation._id,
    ...content.fields,
    ...reply,
    sendAt,
  });

  const updated = await conversationModel
    .findOneAndUpdate(
      { _id: conversation._id, candidateBlockedAt: null },
      { $set: { latestMessageData: latestOf(message, actorUserId), ...organizationFields(organization) } },
      { new: true }
    )
    .lean();
  if (!updated) {
    await messageModel.deleteOne({ _id: message._id }).catch(() => {});
    throw refusal("ORG_CHAT_BLOCKED");
  }

  const stored = plain(typeof (message as any).toObject === "function" ? (message as any).toObject() : message);
  return { conversation: plain(updated), message: stored };
};

/**
 * POST /organizations/:id/conversations (§3.2): open a conversation with a
 * candidate, with the company's first message, or send that message into the
 * one already there. Resolves to the HTTP status (201 created, 200 existing)
 * and `{ conversation, message }`.
 */
export const openConversation = async (organizationId: string, actorUserId: string, body: unknown) => {
  if (!orgChatEnabled()) throw disabled();
  const parsed = parseOpenBody(body);
  if (!parsed.ok) throw new OrgChatRefusal(400, "VALIDATION_ERROR", `${parsed.field} is invalid`);
  const input = parsed.value;

  let decision;
  try {
    decision = await authorizeOrgChat({
      action: "OPEN",
      organizationId,
      actorUserId,
      candidateUserId: input.candidateUserId,
      basis: input.basis,
      ...(input.applicationId ? { applicationId: input.applicationId } : {}),
      ...(input.matchId ? { matchId: input.matchId } : {}),
    });
  } catch (error) {
    // Fails closed: nobody is contacted on a guess.
    if (error instanceof OrgChatUnavailableError) throw refusal("ORG_CHAT_UNAVAILABLE");
    throw error;
  }

  const pair = { organizationId: new Types.ObjectId(organizationId), candidateUserId: new Types.ObjectId(input.candidateUserId) };
  const sendIntoExisting = async (existing: any) => {
    if (isBlocked(existing)) throw refusal("ORG_CHAT_BLOCKED");
    const sent = await storeCompanyMessage(existing, actorUserId, decision.organization, { body: input.firstMessage });
    announceOrgMessage(sent.conversation, sent.message);
    return { status: 200, ...sent };
  };

  if (!decision.allow) {
    // The cap counts new conversations only, and the backend decides it last:
    // DAILY_LIMIT means everything else passed. The first message still goes
    // into a conversation that already exists.
    if (decision.code === "ORG_CHAT_DAILY_LIMIT") {
      const existing = await conversationModel.findOne(pair).lean();
      if (existing) return sendIntoExisting(existing);
    }
    throw refusal(decision.code);
  }

  const existing = await conversationModel.findOne(pair).lean();
  if (existing) return sendIntoExisting(existing);

  // The message first, then the conversation that points at it: a
  // conversation never exists without the company's first message.
  const conversationId = new Types.ObjectId();
  const content = companyContent({ body: input.firstMessage });
  if (!content.ok) throw new OrgChatRefusal(400, "VALIDATION_ERROR", "firstMessage is invalid");
  const sendAt = new Date();
  const message = await messageModel.create({
    sender: actorUserId,
    actorUserId,
    sendAsOrganizationId: pair.organizationId,
    conversation: conversationId,
    ...content.fields,
    sendAt,
  });

  let created;
  try {
    created = await conversationModel.create({
      _id: conversationId,
      conversationType: "PRIVATE",
      organizationId: pair.organizationId,
      candidateUserId: pair.candidateUserId,
      participants: [{ user: pair.candidateUserId, userType: "USER", joinDate: sendAt }],
      ...organizationFields(decision.organization),
      basis: decision.basis ?? input.basis,
      ...(decision.jobId && isObjectIdString(decision.jobId) ? { jobId: new Types.ObjectId(decision.jobId) } : {}),
      ...(input.basis === "APPLICATION" && input.applicationId ? { applicationId: new Types.ObjectId(input.applicationId) } : {}),
      openedBy: new Types.ObjectId(actorUserId),
      latestMessageData: latestOf(message, actorUserId),
    });
  } catch (error) {
    await messageModel.deleteOne({ _id: message._id }).catch(() => {});
    // Two opens for the same pair at once: the partial unique index let one
    // through, and this one sends into it.
    if ((error as { code?: number })?.code === 11000) {
      const winner = await conversationModel.findOne(pair).lean();
      if (winner) return sendIntoExisting(winner);
    }
    throw error;
  }

  // Counted only now that it exists; best effort.
  void reportOpened(organizationId);
  logEvent({ msg: "org_conversation_opened", organizationId, conversationId: String(conversationId), basis: decision.basis ?? input.basis, actorUserId });

  const conversation = plain(typeof (created as any).toObject === "function" ? (created as any).toObject() : created);
  const stored = plain(typeof (message as any).toObject === "function" ? (message as any).toObject() : message);
  announceOrgMessage(conversation, stored);
  return { status: 201, conversation, message: stored };
};

/** The candidate as the company inbox shows them: public fields only, never the email. */
export const CANDIDATE_PUBLIC_FIELDS = "fullName userName displayName profileImage";

/** GET /organizations/:id/conversations: newest first, each with the company side's `unread`. */
export const listConversations = async (organizationId: string, actorUserId: string, skip: number, limit: number) => {
  await requireMember(organizationId, actorUserId, "LIST");
  const conversations = await conversationModel
    .find({ organizationId })
    .populate("participants.user", CANDIDATE_PUBLIC_FIELDS)
    .sort({ updatedAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
  return { conversations: (conversations as any[]).map((conversation) => ({ ...conversation, unread: orgUnread(conversation) })) };
};

/** A company conversation by id, with what the routes below read. Null for any other conversation. */
const findOrgConversation = async (conversationId: string) => {
  if (!isObjectIdString(conversationId)) return null;
  const conversation = await conversationModel.findOne({ _id: conversationId, organizationId: { $ne: null } }).lean();
  return conversation && organizationOf(conversation) ? conversation : null;
};

const notFound = () => new OrgChatRefusal(404, "CONVERSATION_NOT_FOUND", "Conversation not found");

/** A page size as the participant list takes it: 30 by default, at most 100. */
const pageOf = (skip: unknown, limit: unknown) => ({
  skip: Math.max(0, Number.parseInt(String(skip ?? "0"), 10) || 0),
  limit: Math.min(100, Math.max(1, Number.parseInt(String(limit ?? "30"), 10) || 30)),
});

/**
 * GET /organizations/conversations/:id/messages?before&skip&limit: the
 * company's view of the messages, newest first, as the participant list
 * pages them (skip and limit), and also from before a time or a message id.
 */
export const listMessages = async (conversationId: string, actorUserId: string, query: Record<string, unknown>) => {
  if (!orgChatEnabled()) throw disabled();
  const conversation = await findOrgConversation(conversationId);
  if (!conversation) throw notFound();
  await requireMember(organizationOf(conversation)!, actorUserId, "READ", { hideNotMember: true });

  const { skip, limit } = pageOf(query.skip, query.limit);
  const filter: Record<string, unknown> = { conversation: conversation._id };
  const before = typeof query.before === "string" ? query.before : undefined;
  if (before) {
    let at: Date | null = null;
    if (isObjectIdString(before)) {
      const anchor = await messageModel
        .findOne({ _id: before, conversation: conversation._id })
        .select("createdAt")
        .lean<{ createdAt?: Date } | null>();
      at = anchor?.createdAt ? new Date(anchor.createdAt) : null;
      if (!at) throw new OrgChatRefusal(400, "VALIDATION_ERROR", "before is not a message of this conversation");
    } else {
      at = new Date(before);
      if (Number.isNaN(at.getTime())) throw new OrgChatRefusal(400, "VALIDATION_ERROR", "before is invalid");
    }
    filter.createdAt = { $lt: at };
  }
  const messages = await messageModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();
  return { messages };
};

/**
 * POST /organizations/conversations/:id/messages, and POST /messages with
 * sendAsOrganizationId: a member answers for the company.
 */
export const sendAsOrganization = async (conversationId: string, actorUserId: string, input: CompanyMessageInput) => {
  // The type and the sticker are refused before anything is read, as they always were.
  const content = companyContent(input);
  if (!content.ok && content.code !== "VALIDATION_ERROR") throw new OrgChatRefusal(400, content.code, "Invalid message");
  const conversation = await findOrgConversation(conversationId);
  if (!conversation) throw notFound();
  const { organization } = await requireMember(organizationOf(conversation)!, actorUserId, "SEND", { hideNotMember: true });
  const sent = await storeCompanyMessage(conversation, actorUserId, organization, input);
  announceOrgMessage(sent.conversation, sent.message);
  return sent.message;
};

/**
 * PUT /organizations/conversations/:id/read: the company has read up to now.
 *
 * `orgSide.lastReadAt` moves forward only ($max), `lastReadBy` is the member,
 * and nothing reorders the list (timestamps off). When the latest message is
 * the candidate's and this read is what made it read, `readAllAt` is set
 * (CHAT-CONTRACT.md §1.2 step 5: the company is "everyone else" here) and the
 * candidate alone hears READ_MESSAGE with `readerId` = the member, which
 * their ticks take as "the other side read". Old app builds read any
 * READ_MESSAGE as "this chat is read for me", so it goes to the candidate
 * only when it is about their own message.
 */
export const readAsOrganization = async (conversationId: string, actorUserId: string) => {
  if (!orgChatEnabled()) throw disabled();
  const conversation = await findOrgConversation(conversationId);
  if (!conversation) throw notFound();
  const organizationId = organizationOf(conversation)!;
  await requireMember(organizationId, actorUserId, "READ", { hideNotMember: true });

  const now = new Date();
  const before: any = await conversationModel
    .findOneAndUpdate(
      { _id: conversation._id, organizationId: conversation.organizationId },
      {
        $max: { "orgSide.lastReadAt": now, "orgSide.lastDeliveredAt": now },
        $set: { "orgSide.lastReadBy": new Types.ObjectId(actorUserId) },
      },
      { returnDocument: "before", timestamps: false }
    )
    .lean();
  if (!before) throw notFound();

  const previous = before.orgSide?.lastReadAt ? new Date(before.orgSide.lastReadAt) : null;
  const lastReadAt = previous && previous.getTime() > now.getTime() ? previous : now;

  const latest = before.latestMessageData ?? {};
  const candidate = candidateOf(before);
  let readAllAt: Date | null = latest.readAllAt ? new Date(latest.readAllAt) : null;
  let readAllJustSet = false;
  if (!latest.readAllAt && latest.messageId && candidate && idString(latest.senderId) === candidate) {
    const marked = await conversationModel.updateOne(
      { _id: conversation._id, "latestMessageData.messageId": latest.messageId, "latestMessageData.readAllAt": null },
      { $set: { "latestMessageData.readAllAt": now } },
      { timestamps: false }
    );
    if (marked.modifiedCount > 0) {
      readAllJustSet = true;
      readAllAt = now;
      // The candidate's messages up to the latest; a company message is never "read by all" from here.
      await messageModel.updateMany(
        { conversation: conversation._id, readAllAt: null, sendAsOrganizationId: null, sendAt: { $lte: latest.sendAt ?? now } },
        { $set: { readAllAt: now } },
        { timestamps: false }
      );
    }
  }

  if (readAllJustSet && candidate) {
    void pub.publish(
      "READ_MESSAGE",
      JSON.stringify({
        userIds: [candidate],
        conversationId: String(conversation._id),
        readerId: actorUserId,
        readAt: lastReadAt.toISOString(),
        readAllAt: readAllAt ? readAllAt.toISOString() : null,
      })
    );
  }

  return {
    conversationId: String(conversation._id),
    lastReadAt: lastReadAt.toISOString(),
    readAllAt: readAllAt ? readAllAt.toISOString() : null,
  };
};

/**
 * PUT /conversations/:id/mute { muted }: the caller's own switch on any
 * conversation they are in. A muted conversation is not pushed to them
 * (services/chat-push.ts already reads `participants[].isMuted`).
 */
export const muteConversation = async (conversationId: string, userId: string, muted: boolean) => {
  if (!orgChatEnabled()) throw disabled();
  const result = await conversationModel.updateOne(
    { _id: conversationId, ...participantOf(userId) },
    { $set: { "participants.$[me].isMuted": muted } },
    { arrayFilters: [{ "me.user": new Types.ObjectId(userId) }], timestamps: false }
  );
  if (result.matchedCount === 0) throw notFound();
  return { conversationId, muted };
};

/**
 * POST /conversations/:id/block: the candidate blocks the company, for good.
 * Idempotent: a second block answers the first one's time. The block holds
 * on the conversation at once; the backend is told so that eligibility and
 * every later OPEN refuse it too (a failure there is logged and retried by
 * the next block call).
 */
export const blockOrganization = async (conversationId: string, userId: string) => {
  if (!orgChatEnabled()) throw disabled();
  const conversation = await conversationModel
    .findOne({ _id: conversationId, ...participantOf(userId) })
    .select("organizationId candidateUserId candidateBlockedAt participants.user")
    .lean();
  if (!conversation) throw notFound();
  const organizationId = organizationOf(conversation);
  if (!organizationId) {
    throw new OrgChatRefusal(400, "NOT_ORGANIZATION_CONVERSATION", "Only a company conversation can be blocked");
  }
  if (candidateOf(conversation) !== userId) throw notFound();

  const now = new Date();
  const result = await conversationModel.updateOne(
    { _id: conversation._id, candidateBlockedAt: null },
    { $set: { candidateBlockedAt: now } },
    { timestamps: false }
  );
  let blockedAt: Date = now;
  if (result.modifiedCount === 0) {
    const current = await conversationModel.findOne({ _id: conversation._id }).select("candidateBlockedAt").lean();
    blockedAt = current?.candidateBlockedAt ? new Date(current.candidateBlockedAt as any) : now;
  }

  const recorded = await reportBlock({ userId, organizationId, conversationId: String(conversation._id) });
  logEvent({ msg: "org_chat_blocked", conversationId: String(conversation._id), organizationId, userId, backend: recorded });
  return { conversationId: String(conversation._id), blockedAt: blockedAt.toISOString() };
};

/** Organizations a socket joins the rooms of, at most. */
const MAX_ORG_ROOMS = 20;
/** How long a user's memberships are trusted at SETUP. */
const MEMBERSHIPS_CACHE_SECONDS = 60;

/**
 * The `org:{orgId}` rooms a member's socket joins at SETUP (§3.4): every
 * organization they are an ACTIVE member of (looked up at most every 60 s)
 * that lets them LIST (authorize, cached). Empty with the switch off, and on
 * any failure: the user's own room is what matters.
 */
export const orgRoomsFor = async (userId: string): Promise<string[]> => {
  if (!orgChatEnabled() || !isObjectIdString(userId)) return [];
  try {
    const key = `orgchat:orgs:${userId.toLowerCase()}`;
    let organizationIds: string[] | null = null;
    const hit = await cache.get(key).catch(() => null);
    if (hit) {
      try {
        const parsed = JSON.parse(hit);
        if (Array.isArray(parsed)) organizationIds = parsed.filter(isObjectIdString);
      } catch {
        // Not ours: read the memberships again.
      }
    }
    if (!organizationIds) {
      const rows = await organizationMemberModel
        .find({ userId: new Types.ObjectId(userId), status: "ACTIVE" })
        .select("organizationId")
        .limit(MAX_ORG_ROOMS)
        .lean();
      organizationIds = (rows as any[]).map((row) => idString(row.organizationId)).filter((id): id is string => Boolean(id && isObjectIdString(id)));
      await cache.set(key, JSON.stringify(organizationIds), MEMBERSHIPS_CACHE_SECONDS).catch(() => {});
    }

    const rooms = await Promise.all(
      organizationIds.slice(0, MAX_ORG_ROOMS).map(async (organizationId) => {
        try {
          const decision = await authorizeOrgChat({ action: "LIST", organizationId, actorUserId: userId });
          return decision.allow ? orgRoomOf(organizationId) : null;
        } catch {
          return null;
        }
      })
    );
    return rooms.filter((room): room is string => room !== null);
  } catch (error) {
    console.error("org rooms lookup failed", { userId, error: error instanceof Error ? error.message : error });
    return [];
  }
};
