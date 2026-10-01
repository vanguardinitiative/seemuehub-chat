/**
 * The Lao line an order step leaves in its conversation. The backend posts the
 * step (`latestMessageData.orderStep`); this is what both parties read. A step
 * this list does not know yet still says something, in English, so a backend
 * that ships a new step before this service does is visible, not silent.
 */
const ORDER_STEP_MESSAGES: Record<string, string> = {
  SUBMITTED_PROPOSAL: "ສ້າງໃບສະເໜີລາຄາສຳເລັດເເລ້ວ ສາມາດກວດສອບໄດ້ເລີຍ",
  ACCEPTED_PROPOSAL: "ອະນຸມັດໃບສະເໜີລາຄາສຳເລັດເເລ້ວ",
  REJECTED_PROPOSAL: "ປະຕິເສດໃບສະເໜີລາຄາ",
  PAYMENT_SUCCESS: "ຊຳລະເງິນສຳເລັດເເລ້ວ ເລີ່ມວຽກໄດ້ເລີຍ",
  SUBMITTED_DELIVERABLE: "ສົ່ງມອບວຽກເເລ້ວ ສາມາດກວດສອບໄດ້ເລີຍ",
  REJECTED_DELIVERABLE: "ຕ້ອງການເເກ້ໄຂການສົ່ງມອບວຽກ",
  COMPLETED: "Order ສຳເລັດເເລ້ວ",
  // The buyer or the seller cancelled the unpaid order; nothing more can be
  // done to it, but the conversation stays open.
  CANCELLED: "Order ຖືກຍົກເລີກແລ້ວ",
  // The seller took a gig order at its package price (no quote needed).
  ACCEPTED_ORDER: "ຟຣີແລນຊ໌ຮັບວຽກແລ້ວ ຕາມລາຄາແພັກເກດ — ກະລຸນາຊຳລະເງິນເພື່ອເລີ່ມວຽກ",
  // Nobody answered a delivery for 3 days: the backend approved it and paid out.
  AUTO_APPROVED:
    "ລະບົບອະນຸມັດວຽກອັດຕະໂນມັດ (ຄົບ 3 ວັນຫຼັງສົ່ງມອບ) — Order ສຳເລັດ ແລະ ໂອນເງິນໃຫ້ຟຣີແລນຊ໌ແລ້ວ",
  // Either party (or an admin) reported a problem; the money stays held.
  DISPUTE_OPENED: "ມີການລາຍງານບັນຫາ — Order ຖືກລະງັບໄວ້ຊົ່ວຄາວ ທີມງານ Seemuehub ຈະກວດສອບ",
  DISPUTE_RELEASED: "ທີມງານ Seemuehub ຕັດສິນແລ້ວ: ຈ່າຍເງິນໃຫ້ຟຣີແລນຊ໌",
  DISPUTE_REFUNDED: "ທີມງານ Seemuehub ຕັດສິນແລ້ວ: ຄືນເງິນໃຫ້ລູກຄ້າ",
};

export const orderStepMessage = (step: string): string =>
  ORDER_STEP_MESSAGES[step] ?? `Order status updated to ${step}`;
