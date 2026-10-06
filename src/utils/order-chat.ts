import { OrderStatus } from "@/models/conversation";

/**
 * An order's chat closes when the order COMPLETES (worktrees/CHAT-CONTRACT.md
 * §1.10): its parties can no longer send in it, as the web already shows. It
 * stays readable, and reactions still work. CANCELLED and REFUNDED orders
 * keep an open chat on purpose.
 *
 * Only the parties' own sends are refused: the socket NEW_MESSAGE /
 * NEW_GROUP_MESSAGE and the REST POST /messages. The service's messages - an
 * order step through POST /orders, Seemue AI's AGENT messages - are stored by
 * their own paths and never go through this check.
 *
 * Pure: no Mongo, no Redis.
 */

/** The conversation is an order's, and the order is COMPLETED. */
export const isCompletedOrderChat = (conversation: { orderStatus?: unknown } | null | undefined): boolean =>
  conversation?.orderStatus === OrderStatus.COMPLETED;

/** What POST /messages answers with, in the words the web's locked composer uses. */
export const ORDER_COMPLETED_MESSAGE = "ບໍ່ສາມາດສົ່ງຂໍ້ຄວາມໃນ Order ທີ່ສຳເລັດແລ້ວ";
