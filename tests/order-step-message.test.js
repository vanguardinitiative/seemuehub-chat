/**
 * Runs against the compiled dist/ (see conversation-access.test.js): the line
 * each order step leaves in a conversation. A step the backend sends must have
 * Lao text here before the backend ships it, or the room keeps the English
 * fallback for good.
 */
const test = require("node:test");
const assert = require("node:assert");
const { orderStepMessage } = require("../dist/controllers/order/step-message");

const BACKEND_STEPS = [
  "SUBMITTED_PROPOSAL",
  "ACCEPTED_PROPOSAL",
  "REJECTED_PROPOSAL",
  "PAYMENT_SUCCESS",
  "SUBMITTED_DELIVERABLE",
  "REJECTED_DELIVERABLE",
  "COMPLETED",
  "CANCELLED",
  "ACCEPTED_ORDER",
  "AUTO_APPROVED",
  "DISPUTE_OPENED",
  "DISPUTE_RELEASED",
  "DISPUTE_REFUNDED",
];

test("every step the backend sends reads in Lao", () => {
  for (const step of BACKEND_STEPS) {
    const text = orderStepMessage(step);
    assert.ok(!text.startsWith("Order status updated"), `${step} has no Lao text`);
    assert.match(text, /[\u0E80-\u0EFF]/, `${step} is not Lao`);
  }
});

test("the new steps say what happened", () => {
  assert.match(orderStepMessage("ACCEPTED_ORDER"), /ຮັບວຽກ/);
  assert.match(orderStepMessage("AUTO_APPROVED"), /ອັດຕະໂນມັດ/);
  assert.match(orderStepMessage("DISPUTE_OPENED"), /ລາຍງານບັນຫາ/);
  assert.match(orderStepMessage("DISPUTE_REFUNDED"), /ຄືນເງິນ/);
});

test("an unknown step still says something", () => {
  assert.strictEqual(orderStepMessage("SOMETHING_NEW"), "Order status updated to SOMETHING_NEW");
});
