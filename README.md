# seemuehub-chat

Chat and live-update service for Seemuehub. One Node process serves:

- REST under `/v1/api` (conversations, messages, read status, and the internal
  `/core-socket/payment`, `/orders` and `/agent-messages` hooks the backend
  calls), and
- socket.io on the same port, fanned out across instances with Redis pub/sub.

Pushing to `dev` deploys to production (`.github/workflows/deploy.yml`), so work
on a branch and open a PR.

## Run and test

```sh
npm install          # never npm ci: no lockfile is committed
npm run build        # tsc && tsc-alias
npm test             # builds, then node --test tests/ against dist/
```

The tests need neither Mongo nor Redis.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `PORT` | no (8181) | HTTP and socket port |
| `MONGODB_URI` | yes | Shared database with seemuehub-backend |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | yes | Pub/sub between instances |
| `JWT_SECRET_KEY` | yes | The backend's `JWT_SECRET`; verifies access tokens for REST and sockets |
| `CHAT_INTERNAL_KEY` | recommended | Shared with seemuehub-backend. When set, the backend-only routes (`POST /orders`, `POST /core-socket/payment`) require it as `X-Internal-Key`; `POST /agent-messages` requires it always and refuses everyone while it is unset. See [Internal routes](#internal-routes-and-chat_internal_key) |
| `SOCKET_AUTH_MODE` | no (`permissive`) | `permissive` or `enforce`; see below. Any other value stops the service at boot |
| `BACKEND_URL` | no | seemuehub-backend's origin (`https://api.seemuehub.com`, no `/api/v1`). With `CHAT_INTERNAL_KEY`, new private messages are pushed through it; see [Push notifications](#push-notifications). Not a URL: the service stops at boot |
| `STICKER_URL_PREFIX` | no (`https://seemuehub-storage.s3.ap-southeast-1.amazonaws.com/images/`) | Where sticker images live; a `STICKER` message's attachment must start with it (see [Stickers](#stickers)). Only needs setting if the bucket moves. Not an https URL ending in `/`: the service stops at boot |
| `ORG_CHAT_ENABLED` | no (`false`) | `true` turns on company ↔ candidate chat (see [Company conversations](#company-conversations)); needs `BACKEND_URL`, `CHAT_INTERNAL_KEY` and the backend's own `ORG_CHAT_ENABLED` |

`.env.example` lists them all. In production these come from the `ENV`
repository secret, which the deploy writes to `.env` for
`docker-compose.prod.yml` (`env_file: .env`). A changed
secret takes effect on the next deploy (re-run the latest deploy workflow).

## Sockets

### Connecting

Send the same access token REST gets as `Authorization: Bearer …`:

```js
import { io } from "socket.io-client";

const socket = io(CHAT_URL, {
  // A function, so every reconnect sends the current token.
  auth: (cb) => cb({ token: getAccessToken() }), // raw or "Bearer <token>"
});
socket.on("connect", () => socket.emit("SETUP", {}));
```

The token's `userId` claim is the caller. A present but bad token refuses the
connection with `connect_error`:

| `err.message` / `err.data.code` | What the client does |
| --- | --- |
| `TOKEN_EXPIRED` | Refresh the access token, then `socket.connect()` |
| `TOKEN_INVALID` | Treat as signed out |

A socket that sends no token at all is a **legacy** socket (see
`SOCKET_AUTH_MODE`).

### Client → server

| Event | Payload | Notes |
| --- | --- | --- |
| `SETUP` | `{ userId?, conversationId? }` | Joins the caller's room, which is where their messages, orders and payments arrive. `userId` is ignored for an authenticated socket (a mismatch is logged). `conversationId` also joins that conversation's room (`NEW_MESSAGE_PAGE`) if the caller is a participant. Emit after every `connect`. |
| `NEW_MESSAGE` | `{ _id?, conversationId?, receiverId?, messageType, content, attachments?, replyTo?, ... }` | `senderId` is the caller whatever the payload says. With `conversationId` the caller must be a participant and `receiverId` is not needed (ignored if sent; a company conversation has no other participant); without it, `receiverId` is required and the private conversation between caller and `receiverId` is found or created. `replyTo` makes it a [reply](#replies). |
| `NEW_GROUP_MESSAGE` | `{ _id?, conversationId, messageType, content, replyTo?, ... }` | The caller must already be a participant. |
| `REACT_MESSAGE` | `{ messageId, emoji }` | Sets the caller's [reaction](#reactions); `emoji: null` removes it. Authenticated sockets only. |
| `TYPING` | `{ conversationId, typing }` | The [typing indicator](#typing), relayed to the other participants. Authenticated sockets only. |
| `DELIVERED` | `{ conversationId, upTo? }` | This device has the conversation's messages up to `upTo` (ISO; default now): the [delivered state](#delivered-state). Send it when a `NEW_MESSAGE` from someone else arrives. Authenticated sockets only. |

`messageType` must be one a client may send: `TEXT`, `IMAGE`, `VIDEO`,
`VOICE`, `FILE`, `REACTION`, `STICKER`, `LOCATION`, `VOICE_CALL`,
`VIDEO_CALL`. `SYSTEM`, the `ORDER_*` types (they render as order events) and
`AGENT` (a [Seemue AI card](#seemue-ai-messages-agent)) are the service's own
and are refused with `ERROR` `INVALID_PAYLOAD`,
`field: "messageType"`, from verified and legacy sockets alike. The REST sends
(`POST /messages`, `POST /organizations/conversations/:id/messages`) store
`TEXT` (or a valid `STICKER`, below) and answer 400 to a server-only type.

Fields a client cannot set on a message: `sender`, `actorUserId`,
`sendAsOrganizationId`, `isOrderMessage`, `orderId`, `orderStatus`,
`orderStep`, `orderAction`, `isDeleted`, `deletedAt`, `deletedBy`,
`deliveredAllAt`, `readAllAt`, `replyPreview`, `reactions`, `agent`. They are dropped (the
REST sends never read them at all). `isReply` is always the service's own
verdict on `replyTo`.

### Stickers

A sticker is a message like any other (`worktrees/STICKER-CONTRACT.md` §4):

```js
{ messageType: "STICKER", content: "STICKER",
  attachments: [{ fileName: "<sticker _id>", fileUrl: "<sticker url>" }] }
```

Every send path (`NEW_MESSAGE`, `NEW_GROUP_MESSAGE` and both REST sends)
checks it (`src/utils/sticker.ts`): exactly one attachment, a `fileUrl` under
`STICKER_URL_PREFIX` (also once `..` is resolved), and a `fileName` that is a
24-hex id. A sticker that passes is stored with `content: "STICKER"` and the
attachment cut down to `{ fileName, fileUrl }`, whatever was sent. One that
fails is refused from verified and legacy sockets alike with `ERROR`
`INVALID_PAYLOAD`, `field: "attachments"`, and over REST with `400`
`{ code: "CHAT-400", message: "Invalid sticker" }`, before anything is read.
Whether the sticker still exists in the backend is not checked.

`latestMessageData.messageType` is the latest message's type, so a list can
say "Sticker". Conversations whose latest message predates it, and the ones
seemuehub-backend writes itself, have none: treat a missing `messageType`
with `content: "STICKER"` as a sticker.

### Replies

A client makes a message a reply by adding `replyTo: "<messageId>"` to
`NEW_MESSAGE` / `NEW_GROUP_MESSAGE` (`worktrees/CHAT-CONTRACT.md` §2). Once
the send has resolved its conversation, the target must exist in that same
conversation and be neither deleted, nor an order message, nor one of the
service's own (`SYSTEM`, `ORDER_*`, `AGENT`). Then the message
is stored with `isReply: true`, `replyTo`, and a `replyPreview` the service
builds from the stored target (`src/utils/reply.ts`):

```js
replyPreview: {
  messageId, senderId, messageType,
  text,       // TEXT: the content, at most 160 UTF-16 units, never cut inside a character; other types: ""
  fileName?,  // FILE: the attachment's originalName, else its fileName
  thumbUrl?,  // IMAGE: the attachment's fileUrl; STICKER: the sticker's url (its attachment)
}
```

Any other `replyTo` (not an id, missing, another conversation, deleted, an
order message, a `SYSTEM` / `ORDER_*` / `AGENT` message) is dropped and the message is delivered as a normal one, with
a `{"msg":"reply_dropped","reason":...}` line. The preview is a copy: it stays
as it was if the target is later deleted. The REST sends ignore `replyTo`.
Old clients see a normal message.

### Reactions

One reaction per person per message, from a fixed set of six, in this order
everywhere: 👍 ❤️ 😂 😮 😢 🙏 (exact strings; ❤️ is U+2764 U+FE0F)
(`worktrees/CHAT-CONTRACT.md` §3).

`REACT_MESSAGE { messageId, emoji }` sets the caller's reaction (`null`
removes it; the same emoji again just replaces it, so toggling is the
client's: send `null`). Refusals are `ERROR { code, event: "REACT_MESSAGE",
messageId }`:

| `code` | When |
| --- | --- |
| `RATE_LIMITED` | more than 10 `REACT_MESSAGE` in 10 s from this socket (counted first, refused ones included) |
| `INVALID_PAYLOAD` | `field: "messageId"`: not an id, or a deleted, order, `SYSTEM`, `ORDER_*` or `AGENT` message; `field: "emoji"`: not `null` nor one of the six |
| `NOT_PARTICIPANT` | the caller is not in the message's conversation, or the message does not exist (the same answer, so ids cannot be probed) |
| `AUTH_REQUIRED` | a legacy (tokenless) socket, in either mode |

The write is one pipeline update with timestamps off
(`src/services/reactions.ts`): it never touches the message's `updatedAt`,
the conversation, `latestMessageData`, `readAllAt` or anyone's unread state.
Then every participant's room, the reactor's included (their other devices),
gets `CONVERSATION_LISTENING` `REACTION` with the message's whole list;
clients replace theirs with it.

When the reaction is new from someone else (added, or changed to another
emoji; not removed, not the same again), the message's author gets a push
(see [Push notifications](#push-notifications)).

### Typing

`TYPING { conversationId, typing }` (`worktrees/CHAT-CONTRACT.md` §4) goes to
the conversation's other participants as `CONVERSATION_LISTENING` `TYPING`,
never to the typer's own devices. Nothing is written. Membership is looked
up once per socket and kept for 10 minutes, with the other participants (a
refusal for a minute). At most one is forwarded per second per conversation
per socket; the rest are dropped silently, except a `typing: false` after a
forwarded `true`, which always goes. When a socket disconnects, it sends
`typing: false` wherever it last said `true`. `ERROR` `INVALID_PAYLOAD`
(not an id, or `typing` not a boolean), `NOT_PARTICIPANT` or
`AUTH_REQUIRED` (legacy socket) answer the rest.

### Server → client

| Event | `type` | `response` | Sent to |
| --- | --- | --- | --- |
| `CONVERSATION_LISTENING` | `NEW_MESSAGE` | the stored message | every participant's room (4 s later for FILE/VIDEO/VOICE); for a [resend](#resending-a-message) of a stored message, only the resending socket |
| `CONVERSATION_LISTENING` | `NEW_MESSAGE_PAGE` | the stored message | the conversation room |
| `CONVERSATION_LISTENING` | `READ_MESSAGE` | the conversationId, with `readerId`, `readAt`, `readAllAt` beside it (see [Read state](#read-state)) | the reader, and the latest sender when that read made it read by all |
| `CONVERSATION_LISTENING` | `ORDER` | the order conversation from the backend, with `latestMessageData` and `updatedAt` as stored after the step (the step's own message) | participants |
| `CONVERSATION_LISTENING` | `USER_ONLINE` | `{ userId, isOnline }` | users who share a conversation with `userId` (as of that user's SETUP) |
| `CONVERSATION_LISTENING` | `REACTION` | `{ conversationId, messageId, reactions: [{ user, emoji, at }] }`, the message's whole list (`at` ISO) | every participant, the reactor included |
| `CONVERSATION_LISTENING` | `TYPING` | `{ conversationId, userId, typing }` | the other participants (never the typer) |
| `CONVERSATION_LISTENING` | `DELIVERED` | `{ conversationId, userId, deliveredAt }`: `userId`'s devices have everything up to `deliveredAt` (ISO) | the other participants (never `userId`), see [Delivered state](#delivered-state) |
| `LISTENING` | `PAYMENT` | the payment (`_id, userId, type, status, amount, subtotalAmount, processingFeeAmount, currency, referenceId, ...`) | the payer's room |
| `ERROR` | | `{ code, message, event, conversationId?, _id?, messageId?, field? }` | the socket that caused it |

`REACTION`, `TYPING` and `DELIVERED` are new; clients that do not know a
`type` ignore it (the app's and both webs' handlers drop unknown types).

`ERROR` codes:

| `code` | Meaning |
| --- | --- |
| `AUTH_REQUIRED` | Legacy socket in `enforce` mode, or any legacy socket sending `REACT_MESSAGE`, `TYPING` or `DELIVERED`: reconnect with `auth: { token }` |
| `TOKEN_EXPIRED` | The connection's token has expired since it connected: refresh, reconnect, retry |
| `NOT_PARTICIPANT` | Not a participant of `conversationId` (or, for `REACT_MESSAGE`, of the message's conversation); nothing was stored, joined or sent |
| `INVALID_PAYLOAD` | The payload was not an object, or (`field: "messageType"`) its `messageType` is missing or not one a client may send, or (`field: "attachments"`) a `STICKER` failed the [sticker check](#stickers); `_id` echoes the client's id |
| `MESSAGE_SEND_FAILED` | Storing the message failed (`message` says why), after any [retries](#send-order-and-retries); `_id` echoes the client's id and `conversationId` the payload's (null for a first message sent with `receiverId` only). Nothing was delivered |
| `RATE_LIMITED` | More than 10 `REACT_MESSAGE` in 10 s from this socket; `messageId` echoes the client's |

### Resending a message

A client that never saw its `NEW_MESSAGE` come back (a dropped socket, a
timeout) should resend it with the **same `_id`**. If that `_id` is already
stored as the same sender's message, the insert hits the duplicate key and the
resend is answered, to the resending socket only, with the stored message on
`CONVERSATION_LISTENING` `NEW_MESSAGE` instead of `ERROR`
(`worktrees/CHAT-CONTRACT.md` §1.7). Nothing is stored, published or pushed
again; each such resend logs `{"msg":"message_resent",...}`. An `_id` that
belongs to someone else's message is still `MESSAGE_SEND_FAILED`. Same for
`NEW_GROUP_MESSAGE`.

### Send order and retries

Every send updates its conversation's document (`latestMessageData`) in the
same transaction as the insert, so two sends to one conversation at once (an
album and the caption sent right after it) used to collide: the second died
of a WriteConflict with `MESSAGE_SEND_FAILED`. Now
(`worktrees/CHAT-CONTRACT.md` §1.8):

- A socket's `NEW_MESSAGE` / `NEW_GROUP_MESSAGE` are checked in the order
  they came, and each is queued on its conversation (`src/utils/serialize.ts`;
  a first message without a `conversationId` on the pair of users) before the
  next one is checked. One instance stores a conversation's messages one at a
  time, in that order. The queue is per process: sends on another instance
  are not queued with these.
- A transaction that fails transiently (`TransientTransactionError`, or code
  112 WriteConflict: another instance's send, a read or delivered mark) is run
  again on a fresh session, up to 3 runs in all, 20–80 ms apart, with the same
  `_id`. A commit whose outcome is unknown (`UnknownTransactionCommitResult`)
  is committed again, not rerun (`src/utils/transaction.ts`). Each retry logs
  `{"msg":"message_send_retry",...}`.
- `SEND_MESSAGE` (and the push) goes out only after the commit, so a message
  that was not stored is never delivered.
- A rerun that hits the duplicate key because an earlier run did commit is
  [confirmed](#resending-a-message) to the sender like a resend.

### `SOCKET_AUTH_MODE`

What a legacy (tokenless) socket may do:

- `permissive` (default): everything it always could, trusting the `userId` /
  `senderId` in its payloads. Each event is logged as one JSON line:

  ```json
  {"msg":"legacy_socket","event":"SETUP","mode":"permissive","action":"allowed","socketId":"…","claimedUserId":"…","origin":"https://www.seemuehub.com"}
  ```

  `event` is `connect`, `SETUP`, `NEW_MESSAGE` or `NEW_GROUP_MESSAGE`.
  `REACT_MESSAGE`, `TYPING` and `DELIVERED` carry no identity to trust, so
  a legacy socket gets `AUTH_REQUIRED` for them in this mode too (logged with
  `"action":"refused"`); no client that predates authenticated sockets sends
  them.
  `claimedUserId` is null for a signed-out visitor (the donate page), so count
  distinct non-null `claimedUserId` on `SETUP` lines to measure the signed-in
  clients still on the old protocol.
- `enforce`: a legacy socket may connect and stay connected, but `SETUP`,
  `NEW_MESSAGE` and `NEW_GROUP_MESSAGE` are answered with `ERROR`
  `AUTH_REQUIRED` (still logged, with `"action":"refused"`), and anonymous
  donations are no longer broadcast (below).

Rollout:

1. Deploy with `SOCKET_AUTH_MODE` unset (`permissive`). Nothing changes for
   existing clients; authenticated clients get the new behaviour.
2. Ship the web and mobile clients that connect with `auth: { token }`.
3. Watch `legacy_socket` lines for about 7 days
   (`docker logs seemuehub-chat 2>&1 | grep '"msg":"legacy_socket"'`) until
   signed-in `SETUP`s without a token have stopped.
4. Add `SOCKET_AUTH_MODE=enforce` to the `ENV` secret and redeploy.

Rolling back is setting it back to `permissive` (or removing it).

### Payments and anonymous donations

`POST /core-socket/payment` (the backend, after an IB Bank callback) delivers
`LISTENING` `PAYMENT` to the payer's room. Donations can be anonymous
(`POST /donates` takes optional auth), and the signed-out donate page matches
the result on `referenceId`, the Donate document's ObjectId. That id is not a
secret (ObjectIds are a timestamp and a counter, and the broadcast hands every
one to every socket), so the trimmed `{ type, referenceId, status }` broadcast
for donations only happens in `permissive` mode. In `enforce` mode a donation
reaches its donor's room if the donor was signed in, and nobody otherwise.
Keeping live confirmation for anonymous donors needs an unguessable per-donation
key from the backend (see the PR that introduced this).

Other log lines: `socket_auth_refused` (a bad token at the handshake, with its
code), `setup_user_mismatch` (an authenticated SETUP named another userId),
`sender_override` (an authenticated message named another senderId),
`message_refused` (NOT_PARTICIPANT, or INVALID_PAYLOAD with
`field: "messageType"`, or with `field: "attachments"` and a `reason` of
`ATTACHMENT_COUNT`, `FILE_URL` or `FILE_NAME` for a sticker), `reply_dropped`
(a `replyTo` that was dropped, with a `reason` of `INVALID_ID`, `NOT_FOUND`,
`OTHER_CONVERSATION`, `DELETED`, `ORDER_MESSAGE` or `SERVER_MESSAGE`), `reaction_refused` (a
refused `REACT_MESSAGE`, with its `code` and `reason`),
`delivered_write_failed` (a GET's delivered write failed; the GET still
answered).

## Order conversations

seemuehub-backend creates an order's conversation when the order is created
(`conversationType: "ORDER"`, the buyer and the seller as participants) and
syncs `orderStatus` / `isOrderActive` onto it as the order moves, including
`CANCELLED`. A finished or cancelled order keeps its chat: nothing here
deletes or hides it.

- `GET /conversations` lists every conversation of the caller, cancelled
  orders included. `?orderStatus=NOT_COMPLETE` leaves out `COMPLETED` and
  `CANCELLED`; any other value matches that status exactly.
- To open an order's chat from the order screen:
  `POST /conversations/private` with `{ receiverId, orderId }`, `receiverId`
  being the other party. It answers `201` with the existing conversation
  whatever the order's status, or `data: null` while the backend has not
  created it yet. It never creates one.
- The daily cron (`src/services/cron.ts`, 02:00) marks a conversation still
  `PENDING` 30 days after it was created `CANCELLED` and inactive. It only
  relabels the conversation (not the order in the backend), and the chat
  stays readable.

### Order step messages

`POST /orders` turns the step the backend posts
(`latestMessageData.orderStep`: `ORDER_PLACED`, `SUBMITTED_PROPOSAL`, …,
`DISPUTE_REFUNDED`) into a message (`src/controllers/order`):

```js
{ messageType: "TEXT", isOrderMessage: true, content: "<the step's Lao line>",
  orderStep: "ORDER_PLACED", orderId: "<the conversation's orderId>" }
```

`content` is what old clients show, so it stays. `orderStep` and `orderId`
let a new client draw the step's card without parsing `content`; both arrive
with the message on `NEW_MESSAGE` and from `GET /messages`. `orderId` is left
out when the conversation's is not an ObjectId (it would fail the message).
`orderStep` is not `orderStatus`, which only takes order statuses. Messages
stored before this have neither field. A client cannot set either one.

## Company conversations

A company chats with a candidate (`worktrees/ORG-CHAT-CONTRACT.md` §3,
`src/services/org-chat.ts`). The conversation has one participant, the
candidate, plus `organizationId`, `candidateUserId`, an `organization`
snapshot (`name`, `nameLao`, `logo`, `slug`), `orgSide` (the company's read
state), `basis`, `jobId`, `openedBy` and `candidateBlockedAt`. One per
organization and candidate (a partial unique index). Members are never
participants: they use the routes below, and every one of them asks the
backend first (`POST {BACKEND_URL}/api/v1/internal/org-chat/authorize`,
2 s timeout; LIST/READ/SEND answers cached 60 s in Redis
`orgchat:auth:{orgId}:{userId}`, OPEN never). Backend unreachable: `503
ORG_CHAT_UNAVAILABLE`.

| Route (`/v1/api`) | Who |
| --- | --- |
| `POST /organizations/:id/conversations` `{ candidateUserId, basis, applicationId?, matchId?, firstMessage }` | a member who may OPEN on that basis: `201` new, `200` into the existing one |
| `GET /organizations/:id/conversations?skip&limit` | LIST; each item has `unread` |
| `GET /organizations/conversations/:id` | READ; one conversation, shaped as a list item |
| `GET /organizations/conversations/:id/messages?before&skip&limit` | READ |
| `POST /organizations/conversations/:id/messages`, `POST /messages` with `sendAsOrganizationId` | SEND |
| `PUT /organizations/conversations/:id/read` | READ |
| `PUT /conversations/:id/mute` `{ muted }` | any participant |
| `POST /conversations/:id/block` | the candidate |

A company message carries `sendAsOrganizationId` and `actorUserId` (the
member). Sockets: a member's SETUP joins `org:{orgId}` for each organization
they may LIST; `NEW_MESSAGE`, the candidate's `READ_MESSAGE` and `TYPING`
reach that room. Pushes go to the candidate as the company (`audience:
"CANDIDATE"`, not when muted) and to the company for the candidate's replies
(`audience: "ORGANIZATION"`). After a block nobody sends and the company
cannot reopen. Errors are `{ success: false, errors: { code, message } }`
(`ORG_CHAT_*`, 403; `ORG_CHAT_DAILY_LIMIT`, 429); mute and block keep the
participant routes' `{ code: "CHAT-4xx", message }` and add the same
`errors`. Every refusal, 401 included, carries its specific code in
`errors.code`.

With `ORG_CHAT_ENABLED` off, opening and the new routes answer `403
ORG_CHAT_DISABLED`; the company list and send keep their old rule (an
ACTIVE membership) with no fan-out or push.

## Seemue AI messages (AGENT)

Someone in a conversation asks Seemue AI for something there (an agreement
summary in an order chat, a delivery checklist, a note), and seemuehub-backend
posts the result as an `AGENT` message (`worktrees/AGENT-CONTRACT.md` §8,
`src/services/agent-messages.ts`). Only the backend can: `AGENT` is not a
type clients may send, and `agent` is a field they cannot set.

`POST /v1/api/agent-messages`, `X-Internal-Key` required (fail closed: while
`CHAT_INTERNAL_KEY` is unset it refuses everyone):

```js
{
  conversationId,            // ObjectId
  requestedBy,               // ObjectId: who asked; becomes the sender
  content,                   // Lao plain text, 1–2000 characters once trimmed
  agent: {
    v: 1,
    kind: "AGREEMENT" | "CHECKLIST" | "NOTE",
    card: { type, v, id, fallbackText, ... },   // an AGENT-CONTRACT §4 card, stored as sent
    threadId?, actionId?,                       // ids, [A-Za-z0-9_-]{1,64}
    requestedBy?,                               // if sent, must equal requestedBy
  }
}
```

The card is checked for its common fields only: `type` UPPER_SNAKE, `v` an
integer ≥ 1, `id` a non-empty string, `fallbackText` 1–2000 characters; no
`$…` or `__proto__` keys, at most 12 levels deep and 24,000 characters as
JSON (a whole request stays under express.json's 100 kB).

Who may ask: a participant of the conversation, or, in a company
conversation, a member the backend lets `SEND` for that organization
(`/internal/org-chat/authorize`, cached like the company routes; needs
`ORG_CHAT_ENABLED`). A company conversation the candidate blocked takes
nothing.

It stores `{ messageType: "AGENT", sender: requestedBy, actorUserId:
requestedBy, content, agent: { ...agent, requestedBy }, sendAsOrganizationId
(a member, as the company) }`, points `latestMessageData` at it with one
`updateOne` (timestamps on: it moves the chat up like any message; never
`.save()`), and publishes `SEND_MESSAGE`, so sockets get `NEW_MESSAGE` like
any message (participants' rooms, the page room, a company's `org:{orgId}`
room). It is **never pushed**. Each one logs
`{"msg":"agent_message_posted",...}`.

| Status | Body |
| --- | --- |
| 201 | `{ success: true, data: { message } }`, the stored message, `agent` included |
| 400 | `{ success: false, errors: { code: "VALIDATION_ERROR", message: "<field> is invalid" } }` |
| 401 | `{ success: false, code: "CHAT-401", message: "Unauthorized", errors: { code: "UNAUTHORIZED", message } }` |
| 403 | `errors.code` `NOT_PARTICIPANT`, `ORG_CHAT_BLOCKED`, `ORG_CHAT_DISABLED`, `ORG_CHAT_NOT_MEMBER`, `ORG_CHAT_FORBIDDEN` |
| 404 | `errors.code` `CONVERSATION_NOT_FOUND` |
| 503 | `errors.code` `ORG_CHAT_UNAVAILABLE` (the backend's authorize could not be asked) |

Reading: every message list (`GET /messages`, `/messages/histories`, the
company's and the admin's) returns it as stored, `agent` included, and
`latestMessageData` has `messageType: "AGENT"` with `content`, so a list row
shows the text. Nobody can reply to one (the reply is dropped,
`reason: "SERVER_MESSAGE"`) or react to one (`INVALID_PAYLOAD`).

Old clients need nothing: www and staging (`MessageBubble.svelte`) and the
app (`message-bubble.tsx`) draw a type they do not know as `content` in a
text bubble from the sender, and their list rows show `content`. New clients
draw `agent.card` by its `type`, falling back to `card.fallbackText`.

## Internal routes and `CHAT_INTERNAL_KEY`

Three routes are for seemuehub-backend only:

| Route | Sent by the backend when | What it does here |
| --- | --- | --- |
| `POST /orders` | an order moves a step (`conversation.service` `updateOrderStep`) | stores the step's [message](#order-step-messages) in the order's conversation as the order's sender, and emits `ORDER` to its participants |
| `POST /core-socket/payment` | IB Bank confirms a payment | emits `PAYMENT` to the payer |
| `POST /agent-messages` | Seemue AI answers a request made in a chat | stores an [AGENT message](#seemue-ai-messages-agent) and delivers it |

All three require the shared `CHAT_INTERNAL_KEY` as `X-Internal-Key`
(`src/middleware/internal-key.ts`, compared timing-safe). A missing or wrong
key is a 401 and logs `{"msg":"internal_key_refused",...}`. While the key is
**not set here**, `/orders` and `/core-socket/payment` stay open as they
always were and every call logs `{"msg":"internal_key_unset",...}`: that is
what lets this deploy before the backend sends the header.
`/agent-messages` is new, so it never was open: with no key it refuses every
call (`internal_key_unset` with `"action":"refused"`).

Rollout:

1. Deploy the backend change that sends `X-Internal-Key` on every call to this
   service (seemuehub-backend#37). With no key configured it sends nothing.
2. Deploy this. Nothing changes yet; `internal_key_unset` lines show the calls.
3. Put a long random `CHAT_INTERNAL_KEY` in the **backend's** `ENV` secret and
   redeploy it. (Before this step, setting the key here would refuse the
   backend.)
4. Put the same value in **this service's** `ENV` secret and re-run the latest
   deploy. From now on both routes are closed to everyone but the backend.

Rolling back is removing the key here (step 4). That also closes
`/agent-messages` until the key is back.

## Read state

Who has read what lives on the conversation, in `participants[].lastReadAt`:
a participant has read everything sent at or before it
(`worktrees/CHAT-CONTRACT.md` §1). Private sends never wrote the old
per-message `MessageStatus` rows, so reads used to go nowhere and every chat
looked unread.

`PUT /message-status/read?conversationId=` (any body; the reader is the
token's user):

- moves the caller's `lastReadAt` to now (never back), for a participant
  only: anyone else gets the same 404 as a conversation that does not exist.
  Every type works, including an order step posted by an admin who is not a
  participant. The same update moves `lastDeliveredAt` too (reading also
  delivers: see [Delivered state](#delivered-state));
- in a GROUP, also marks the caller's `MessageStatus` rows READ, as before;
- when everyone but the latest sender has now read the latest message, sets
  `latestMessageData.readAllAt` (and `readAllAt` on the earlier messages from
  others). Never in a GROUP, and never when the only participant sent it;
- publishes `READ_MESSAGE` to the reader's devices, and to the latest sender
  only when this read set `readAllAt` and the sender is a participant. Old app
  builds take any `READ_MESSAGE` as "read for me", so nobody else gets it:

  ```js
  { type: "READ_MESSAGE", response: "<conversationId>", readerId, readAt, readAllAt /* ISO or null */ }
  ```

- answers `200 { code: "CHAT-200", data: { conversationId, lastReadAt, readAllAt } }`.

None of these writes touches `updatedAt`, so reading never reorders the list.

`GET /conversations` and `GET /conversations/:id` set
`latestMessageData.isRead` for the caller: they sent it, or their `lastReadAt`
covers its `sendAt`, or (groups) its `MessageStatus` row says READ. A
conversation without a latest sender counts as read. `participants[].lastReadAt`
is returned with the participants.

### Backfill

Nobody has a `lastReadAt` until they next open a chat, so without a backfill
every existing conversation whose latest message came from someone else stays
`isRead: false`, and the clients' new unread counts would include all of them.
`src/scripts/backfill-read-state.ts` gives each participant without a
`lastReadAt` the latest message's `sendAt`, where that message is older than 7
days or the order is `COMPLETED`, `CANCELLED` or `REFUNDED`; recent messages
in active chats stay unread until opened. It writes with one pipeline
`updateMany` (no `updatedAt` change) and is safe to re-run. Run it inside the
deployed container, which has the service's `MONGODB_URI`:

```sh
sudo docker exec seemuehub-chat node dist/scripts/backfill-read-state.js          # dry run: counts and 5 sample ids
sudo docker exec seemuehub-chat node dist/scripts/backfill-read-state.js --apply  # writes; only with the owner's OK
```

## Delivered state

For WhatsApp's three ticks (✓ sent, grey ✓✓ delivered, blue ✓✓ read), the
conversation also keeps `participants[].lastDeliveredAt`: that participant's
devices have every message sent at or before it (`worktrees/CHAT-CONTRACT.md`
§5.1). Like `lastReadAt` it only moves forward (`$max` on the caller's own
entry) and never touches `updatedAt`. It moves from:

| Trigger | To | Notes |
| --- | --- | --- |
| socket `DELIVERED { conversationId, upTo? }` | `upTo` (no later than now; not a date: now) | Membership from the socket's cache (shared with `TYPING`). At most one write per 2 s per conversation per socket; one sent sooner waits, keeping the latest `upTo`, and is written when the 2 s are up (or when the socket disconnects) |
| `GET /conversations` | now | One `updateMany` for the conversations on the returned page whose latest message is from someone else and not yet delivered to the caller; no write when there are none. Old clients and www deliver this way |
| `GET /messages?conversationId=` | now | The same for that conversation |
| `PUT /message-status/read` | now | In the read's own update |

When a write moves the recipient's mark past the latest message from someone
else, the other participants get `CONVERSATION_LISTENING` `DELIVERED`
`{ conversationId, userId, deliveredAt }`. The GETs' writes never fail the
GET (a failure logs `delivered_write_failed`), and the list goes out with the
new value. Both conversation GETs return `participants[].lastDeliveredAt`.

A message to a phone whose app is closed stays ✓ until that app opens (its
catch-up fetches the list) or its socket connects: a push alone cannot
confirm delivery. Nothing is backfilled: the first list fetch after this
deploys delivers what it shows.

## Push notifications

When a private message is stored (`NEW_MESSAGE`), this service asks
seemuehub-backend, which holds the device tokens, to push it to the other
participants:

```http
POST {BACKEND_URL}/api/v1/internal/push/chat
X-Internal-Key: {CHAT_INTERNAL_KEY}

{ "conversationId", "senderId", "recipientIds": [1..50], "messageType", "snippet"? }
```

- Never to the sender, nor to a participant who muted the conversation.
- `snippet` is a `TEXT` message's text, whitespace folded, at most 140
  characters; other types send none.
- Not for order or system messages: the backend notifies its own order events.
- Fire and forget, after the message is committed, with a 3 s timeout: a slow
  or failing backend never delays or fails a message. Failures log
  `{"msg":"chat_push_failed","conversationId",...}` (ids and status only).
- Skipped silently until both `BACKEND_URL` and `CHAT_INTERNAL_KEY` are set.

A reaction is pushed the same way, to the message's author only
(`worktrees/CHAT-CONTRACT.md` §3.5):

```json
{ "conversationId", "senderId": "<reactor>", "recipientIds": ["<author>"], "messageType": "REACTION", "snippet": "<emoji>" }
```

Only when the reaction is new from someone else (added, or changed to
another emoji), and not to an author who muted the conversation or is no
longer a participant. The backend words it "ສະແດງຄວາມຮູ້ສຶກ {emoji}
ຕໍ່ຂໍ້ຄວາມຂອງທ່ານ" (seemuehub-backend#50, which must be deployed first) and
counts it in the reactor's 30 pushes a minute.

Group messages are not pushed. They used to post a `"platform": "TAXI"` payload
to `NOTIFICATION_URL`, a leftover of the product this service was forked from;
that call is gone and `NOTIFICATION_URL` is no longer read.

To turn pushes on: deploy the backend endpoint (seemuehub-backend#33), set the
same `CHAT_INTERNAL_KEY` on both services (see the rollout above), then add
`BACKEND_URL` to this service's `ENV` and redeploy.
