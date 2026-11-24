import { paymentModel } from "@/models/payment";
import { isObjectIdString } from "@/utils/ids";
import type { DonationPayment } from "@/socket/donation-follow";

/**
 * The DONATE payment a donate page names by its referenceId (the Donate id
 * POST /donates answered it with), for the FOLLOW_DONATION check
 * (socket/donation-follow.ts). Only the four fields the check reads: never
 * the amount, the description or anything the bank reported. Anything but an
 * id string is not looked up.
 */
export const findDonationPayment = async (referenceId: unknown): Promise<DonationPayment | null> => {
  if (!isObjectIdString(referenceId)) return null;
  return paymentModel.findOne({ referenceId, type: "DONATE" }).select("userId type status createdAt").lean<DonationPayment>();
};
