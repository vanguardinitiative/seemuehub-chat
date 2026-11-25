/**
 * Seemuehub is kip only (2026-11-25). A conversation's order budget used to
 * default to THB; it now defaults to LAK, and a THB/USD sent by an older
 * client is stored as LAK. Runs against the compiled dist/, like the others.
 */
require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");

const { conversationModel: Conversation } = require("../dist/models/conversation.js");

test("an order budget without a currency is LAK", () => {
  const doc = new Conversation({ orderBudget: { amount: 350000 } });
  assert.strictEqual(doc.orderBudget.currency, "LAK");
});

test("THB and USD from an older client are stored as LAK", () => {
  for (const code of ["THB", "USD", "thb", "LAK"]) {
    const doc = new Conversation({ orderBudget: { amount: 350000, currency: code } });
    assert.strictEqual(doc.orderBudget.currency, "LAK", code);
  }
});
