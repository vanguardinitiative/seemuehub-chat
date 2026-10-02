import { ORG_CHAT_BASES, type OrgChatBasis } from "@/models/conversation";
import { idString, isObjectIdString } from "@/utils/ids";
import { covers } from "@/utils/read-state";

/**
 * Company ↔ candidate chat's pure rules (worktrees/ORG-CHAT-CONTRACT.md §3):
 * the error codes and their statuses, who the candidate is, the company
 * side's unread flag, the organization snapshot, and the OPEN body. No
 * Mongo, no Redis.
 */

/** The backend's refusal codes, and one of this service's own (§5). */
export const ORG_CHAT_ERRORS = {
  ORG_CHAT_DISABLED: { status: 403, message: "ການແຊັດກັບບໍລິສັດຍັງບໍ່ເປີດໃຫ້ໃຊ້" },
  ORG_CHAT_NOT_MEMBER: { status: 403, message: "ທ່ານບໍ່ແມ່ນສະມາຊິກຂອງບໍລິສັດນີ້" },
  ORG_CHAT_FORBIDDEN: { status: 403, message: "ທ່ານບໍ່ມີສິດແຊັດໃນນາມບໍລິສັດ" },
  ORG_CHAT_NOT_ELIGIBLE: { status: 403, message: "ແຊັດໄດ້ສະເພາະຜູ້ທີ່ປົດລັອກ CV, ຜູ້ສະໝັກວຽກ ຫຼື ຜູ້ທີ່ເຂົ້າກັນ" },
  ORG_CHAT_BLOCKED: { status: 403, message: "ຜູ້ສະໝັກໄດ້ບລັອກບໍລິສັດຂອງທ່ານ" },
  ORG_CHAT_DAILY_LIMIT: { status: 429, message: "ມື້ນີ້ເລີ່ມແຊັດໃໝ່ຄົບ 50 ຄົນແລ້ວ ລອງໃໝ່ມື້ອື່ນ" },
  // Not the backend's: it could not be asked (src/services/org-chat-auth.ts).
  ORG_CHAT_UNAVAILABLE: { status: 503, message: "Organization chat is unavailable, try again shortly" },
} as const;

export type OrgChatErrorCode = keyof typeof ORG_CHAT_ERRORS;

/** A backend code as this service answers it; anything unknown is a plain 403. */
export const orgChatError = (code: unknown): { status: number; code: string; message: string } => {
  const known = typeof code === "string" && code in ORG_CHAT_ERRORS ? (code as OrgChatErrorCode) : null;
  if (!known) return { status: 403, code: typeof code === "string" && code ? code : "ORG_CHAT_FORBIDDEN", message: "Forbidden" };
  return { status: ORG_CHAT_ERRORS[known].status, code: known, message: ORG_CHAT_ERRORS[known].message };
};

/** The first message's length, in characters (contract §3.2). */
export const FIRST_MESSAGE_MAX = 2000;

/** What a conversation's org fields are read from: ids in any shape mongoose or JSON hands them over. */
export interface OrgConversationLike {
  organizationId?: unknown;
  candidateUserId?: unknown;
  candidateBlockedAt?: unknown;
  participants?: { user?: unknown }[] | null;
  orgSide?: { lastReadAt?: unknown } | null;
  latestMessageData?: { senderId?: unknown; sendAt?: unknown } | null;
}

/** The organization a conversation belongs to, or null for every other conversation. */
export const organizationOf = (conversation: OrgConversationLike | null | undefined): string | null => {
  const id = idString(conversation?.organizationId);
  return id && isObjectIdString(id) ? id.toLowerCase() : null;
};

/**
 * The candidate of an organization conversation: `candidateUserId`, or, for
 * one opened before that field, its one participant. Null for any other
 * conversation.
 */
export const candidateOf = (conversation: OrgConversationLike | null | undefined): string | null => {
  if (!organizationOf(conversation)) return null;
  const candidate = idString(conversation?.candidateUserId);
  if (candidate) return candidate;
  const participants = (conversation?.participants ?? []).map((participant) => idString(participant?.user)).filter(Boolean);
  return participants.length === 1 ? (participants[0] as string) : null;
};

/** The candidate blocked the company: nobody sends in it again. */
export const isBlocked = (conversation: OrgConversationLike | null | undefined): boolean =>
  Boolean(organizationOf(conversation) && conversation?.candidateBlockedAt);

/**
 * The company inbox's dot (§3.2): the latest message is the candidate's and
 * newer than the company's last read. A company message is never unread for
 * the company.
 */
export const orgUnread = (conversation: OrgConversationLike | null | undefined): boolean => {
  const latest = conversation?.latestMessageData;
  const candidate = candidateOf(conversation);
  const senderId = idString(latest?.senderId);
  if (!candidate || !senderId || senderId !== candidate) return false;
  return !covers(conversation?.orgSide?.lastReadAt, latest?.sendAt);
};

/** The organization as the backend answered it. */
export interface OrganizationLike {
  name?: unknown;
  nameLao?: unknown;
  logo?: unknown;
  slug?: unknown;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** The snapshot stored on the conversation: only the fields present. */
export const organizationSnapshot = (organization: OrganizationLike | null | undefined) => {
  const snapshot: { name?: string; nameLao?: string; logo?: string; slug?: string } = {};
  for (const field of ["name", "nameLao", "logo", "slug"] as const) {
    const value = text(organization?.[field]);
    if (value) snapshot[field] = value;
  }
  return snapshot;
};

/**
 * The organization's name as the candidate reads it: its Lao name, else its
 * name, as the backend titles the candidate's pushes. Also what goes in
 * `conversationName`, which old clients show when they find no other
 * participant.
 */
export const organizationDisplayName = (organization: OrganizationLike | null | undefined): string | undefined =>
  text(organization?.nameLao) ?? text(organization?.name);

/** The `$set` that (re)writes a conversation's organization snapshot and its old-client fallbacks. */
export const organizationFields = (organization: OrganizationLike | null | undefined): Record<string, unknown> => {
  const snapshot = organizationSnapshot(organization);
  if (!snapshot.name && !snapshot.nameLao) return {};
  return {
    organization: snapshot,
    conversationName: organizationDisplayName(snapshot),
    ...(snapshot.logo ? { conversationImage: snapshot.logo } : {}),
  };
};

export type OpenBody = {
  candidateUserId: string;
  basis: OrgChatBasis;
  applicationId?: string;
  matchId?: string;
  firstMessage: string;
};

/** POST /organizations/:id/conversations' body (§3.2), or the field that is wrong. */
export const parseOpenBody = (body: unknown): { ok: true; value: OpenBody } | { ok: false; field: string } => {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!isObjectIdString(input.candidateUserId)) return { ok: false, field: "candidateUserId" };
  if (!(ORG_CHAT_BASES as readonly unknown[]).includes(input.basis)) return { ok: false, field: "basis" };
  for (const field of ["applicationId", "matchId"] as const) {
    if (input[field] !== undefined && input[field] !== null && !isObjectIdString(input[field])) return { ok: false, field };
  }
  const firstMessage = typeof input.firstMessage === "string" ? input.firstMessage.trim() : "";
  if (firstMessage.length < 1 || Array.from(firstMessage).length > FIRST_MESSAGE_MAX) return { ok: false, field: "firstMessage" };
  return {
    ok: true,
    value: {
      candidateUserId: input.candidateUserId.toLowerCase(),
      basis: input.basis as OrgChatBasis,
      ...(isObjectIdString(input.applicationId) ? { applicationId: input.applicationId } : {}),
      ...(isObjectIdString(input.matchId) ? { matchId: input.matchId } : {}),
      firstMessage,
    },
  };
};
