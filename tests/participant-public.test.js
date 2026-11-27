/**
 * Agencies in chat: every participant the conversation reads return carries
 * `providerType` (unset reads INDIVIDUAL) and the public `agency` block the
 * backend copies onto User.agencyProfile - and never the enterprise
 * registration number, the certificate or agencyDraft. Runs against the
 * compiled dist/, like the others.
 */
require("./helpers/offline");

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");

const {
  ADMIN_PARTICIPANT_FIELDS,
  PARTICIPANT_FIELDS,
  PARTICIPANT_FIELDS_ONLINE,
  providerTypeOf,
  publicAgencyOf,
  withPublicParticipants,
  withPublicProvider,
} = require("../dist/utils/participant-public.js");
const { userModel: User } = require("../dist/models/user.js");
const { conversationModel: Conversation } = require("../dist/models/conversation.js");
const conversationRoute = require("../dist/routes/conversation.js").default;

const CODE = "5512-1311 4000";
const CERTIFICATE = "s3-private://private/documents/507f1f77bcf86cd799439011/cert.pdf";
const SECRETS = [CODE, "551213114000", CERTIFICATE, "agencyDraft", "agencyProfile", "enterpriseCode", "certificateImage"];

const PUBLIC = {
  verified: true,
  organizationType: "AGENCY",
  organizationTypeOther: null,
  website: "https://laosway.test",
  officeAddress: "ບ້ານ ໜອງແຕ່ງ",
  slug: "laosway-travel",
};

/** An agency account as the users collection holds it: the public copy AND the private draft. */
const agencyUser = (fields = {}) => ({
  _id: new Types.ObjectId(),
  userName: "laosway",
  displayName: "ລາວສເວ",
  providerType: "AGENCY",
  agencyProfile: { ...PUBLIC },
  agencyDraft: { enterpriseCode: CODE, certificateImage: CERTIFICATE },
  ...fields,
});
const individual = () => ({ _id: new Types.ObjectId(), userName: "noy", displayName: "Noy", isFreelancer: true });

const assertNoSecrets = (shape) => {
  const text = JSON.stringify(shape);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked ${secret}`);
};

test("providerTypeOf and publicAgencyOf", async (t) => {
  await t.test("unset, null or anything else reads INDIVIDUAL, with no agency block", () => {
    for (const user of [{}, { providerType: null }, { providerType: "COMPANY" }, null, undefined]) {
      assert.strictEqual(providerTypeOf(user), "INDIVIDUAL");
      assert.strictEqual(publicAgencyOf(user), null);
    }
  });
  await t.test("an agency gets exactly the six public fields", () => {
    assert.deepStrictEqual(publicAgencyOf(agencyUser()), PUBLIC);
    assert.deepStrictEqual(publicAgencyOf(agencyUser({ agencyProfile: undefined })), {
      verified: false,
      organizationType: null,
      organizationTypeOther: null,
      website: null,
      officeAddress: null,
      slug: null,
    });
  });
});

test("the populated fields", () => {
  for (const fields of [PARTICIPANT_FIELDS, PARTICIPANT_FIELDS_ONLINE, ADMIN_PARTICIPANT_FIELDS]) {
    assert.ok(fields.includes("providerType") && fields.includes("agencyProfile"), fields);
    assert.ok(!fields.includes("agencyDraft"), fields);
  }
  // What each read populated before, unchanged.
  assert.strictEqual(PARTICIPANT_FIELDS, "userName displayName isFreelancer phone email role profileImage providerType agencyProfile");
  assert.strictEqual(PARTICIPANT_FIELDS_ONLINE, `${PARTICIPANT_FIELDS} isOnline`);
});

test("withPublicProvider and withPublicParticipants", async (t) => {
  await t.test("an agency participant carries providerType AGENCY and the public block, nothing private", () => {
    const shaped = withPublicProvider(agencyUser());
    assert.strictEqual(shaped.providerType, "AGENCY");
    assert.deepStrictEqual(shaped.agency, PUBLIC);
    assert.strictEqual(shaped.displayName, "ລາວສເວ");
    assertNoSecrets(shaped);
  });

  await t.test("an individual is unchanged, plus INDIVIDUAL and agency null", () => {
    const user = individual();
    assert.deepStrictEqual(withPublicProvider(user), { ...user, providerType: "INDIVIDUAL", agency: null });
  });

  await t.test("an unpopulated participant (an id) passes through", () => {
    const id = new Types.ObjectId();
    assert.strictEqual(withPublicProvider(id), id);
  });

  await t.test("every participant of a lean conversation, and of a hydrated one", () => {
    const lean = { _id: new Types.ObjectId(), participants: [{ user: agencyUser(), isMuted: false }, { user: individual() }] };
    const shaped = withPublicParticipants(lean);
    assert.strictEqual(shaped.participants[0].user.providerType, "AGENCY");
    assert.strictEqual(shaped.participants[0].isMuted, false);
    assert.strictEqual(shaped.participants[1].user.providerType, "INDIVIDUAL");
    assertNoSecrets(shaped);
    // A document goes through toJSON first, as res.json would have sent it.
    const doc = { toJSON: () => lean };
    assert.strictEqual(withPublicParticipants(doc).participants[0].user.agency.slug, "laosway-travel");
  });
});

test("the user model keeps the public block on a hydrated document, and has no agencyDraft", () => {
  // What a participant populate fetches: only the PARTICIPANT_FIELDS.
  const { agencyDraft: _notSelected, ...fetched } = agencyUser();
  const doc = User.hydrate({ ...fetched, email: "a@laosway.test", role: "USER" });
  const json = doc.toJSON();
  assert.strictEqual(json.providerType, "AGENCY");
  assert.deepStrictEqual({ ...json.agencyProfile }, PUBLIC);
  // The draft is not part of this service's model at all...
  assert.strictEqual(User.schema.path("agencyDraft"), undefined);
  // ...and even a document that somehow held it is stripped on the way out.
  assertNoSecrets(withPublicProvider(User.hydrate({ ...agencyUser(), email: "a@laosway.test", role: "USER" })));
  // Nothing defaulted onto an account the backend never marked.
  const plain = new User({ email: "noy@example.com", userName: "noy" }).toJSON();
  assert.strictEqual(plain.providerType, undefined);
  assert.strictEqual(plain.agencyProfile, undefined);
});

test("GET /conversations/:id returns each participant with providerType and agency", async () => {
  const caller = new Types.ObjectId();
  const seller = agencyUser();
  const conversationId = new Types.ObjectId();
  let populated = null;

  const originalFindOne = Conversation.findOne;
  Conversation.findOne = () => ({
    populate: (path, fields) => {
      populated = { path, fields };
      return Promise.resolve({
        toJSON: () => ({
          _id: conversationId,
          conversationType: "PRIVATE",
          participants: [
            { user: { _id: caller, userName: "buyer", displayName: "Buyer" } },
            { user: seller },
          ],
        }),
      });
    },
  });

  const app = express();
  app.use(express.json());
  app.use("/conversations", conversationRoute);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const token = jwt.sign({ userId: caller.toString() }, process.env.JWT_SECRET_KEY);
    const body = await new Promise((resolve, reject) => {
      const req = http.request(
        { port: server.address().port, path: `/conversations/${conversationId}`, method: "GET", headers: { Authorization: `Bearer ${token}` } },
        (res) => {
          let raw = "";
          res.on("data", (chunk) => (raw += chunk));
          res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
        }
      );
      req.on("error", reject);
      req.end();
    });

    assert.strictEqual(body.status, 200);
    assert.deepStrictEqual(populated, { path: "participants.user", fields: PARTICIPANT_FIELDS });
    const [buyer, agency] = body.json.data.participants.map((participant) => participant.user);
    assert.strictEqual(buyer.providerType, "INDIVIDUAL");
    assert.strictEqual(buyer.agency, null);
    assert.strictEqual(agency.providerType, "AGENCY");
    assert.deepStrictEqual(agency.agency, PUBLIC);
    assertNoSecrets(body.json.data);
  } finally {
    Conversation.findOne = originalFindOne;
    server.close();
  }
});
