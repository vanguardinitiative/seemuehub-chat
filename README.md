# seemuehub-chat

Chat and live-update service for Seemuehub. One Node process serves:

- REST under `/v1/api` (conversations, messages, read status, and the internal
  `/core-socket/payment` and `/orders` hooks the backend calls), and
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
| `CHAT_INTERNAL_KEY` | recommended | Shared with seemuehub-backend. When set, the backend-only routes (`POST /orders`, `POST /core-socket/payment`) require it as `X-Internal-Key`; see [Internal routes](#internal-routes-and-chat_internal_key) |
| `SOCKET_AUTH_MODE` | no (`permissive`) | `permissive` or `enforce`; see below. Any other value stops the service at boot |
| `BACKEND_URL` | no | seemuehub-backend's origin (`https://api.seemuehub.com`, no `/api/v1`). With `CHAT_INTERNAL_KEY`, new private messages are pushed through it; see [Push notifications](#push-notifications). Not a URL: the service stops at boot |
| `STICKER_URL_PREFIX` | no (`https://seemuehub-storage.s3.ap-southeast-1.amazonaws.com/images/`) | Where sticker images live; a `STICKER` message's attachment must start with it (see [Stickers](#stickers)). Only needs setting if the bucket moves. Not an https URL ending in `/`: the service stops at boot |

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
| `NEW_MESSAGE` | `{ _id?, conversationId?, receiverId, messageType, content, attachments?, ... }` | `senderId` is the caller whatever the payload says. With `conversationId` the caller must be a participant; without it, the private conversation between caller and `receiverId` is found or created. |
| `NEW_GROUP_MESSAGE` | `{ _id?, conversationId, messageType, content, ... }` | The caller must already be a participant. |

`messageType` must be one a client may send: `TEXT`, `IMAGE`, `VIDEO`,
`VOICE`, `FILE`, `REACTION`, `STICKER`, `LOCATION`, `VOICE_CALL`,
`VIDEO_CALL`. `SYSTEM` and the `ORDER_*` types are the service's own (they
render as order events) and are refused with `ERROR` `INVALID_PAYLOAD`,
`field: "messageType"`, from verified and legacy sockets alike. The REST sends
(`POST /messages`, `POST /organizations/conversations/:id/messages`) store
`TEXT` (or a valid `STICKER`, below) and answer 400 to a server-only type.

Fields a client cannot set on a message: `sender`, `actorUserId`,
`sendAsOrganizationId`, `isOrderMessage`, `orderId`, `orderStatus`,
`orderAction`, `isDeleted`, `deletedAt`, `deletedBy`, `deliveredAllAt`,
`readAllAt`. They are dropped.

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

### Server → client

| Event | `type` | `response` | Sent to |
| --- | --- | --- | --- |
| `CONVERSATION_LISTENING` | `NEW_MESSAGE` | the stored message | every participant's room (4 s later for FILE/VIDEO/VOICE) |
| `CONVERSATION_LISTENING` | `NEW_MESSAGE_PAGE` | the stored message | the conversation room |
| `CONVERSATION_LISTENING` | `READ_MESSAGE` | the conversationId | participants |
| `CONVERSATION_LISTENING` | `ORDER` | the order conversation from the backend | participants |
| `CONVERSATION_LISTENING` | `USER_ONLINE` | `{ userId, isOnline }` | users who share a conversation with `userId` (as of that user's SETUP) |
| `LISTENING` | `PAYMENT` | the payment (`_id, userId, type, status, amount, subtotalAmount, processingFeeAmount, currency, referenceId, ...`) | the payer's room |
| `ERROR` | | `{ code, message, event, conversationId?, _id? }` | the socket that caused it |

`ERROR` codes:

| `code` | Meaning |
| --- | --- |
| `AUTH_REQUIRED` | Legacy socket in `enforce` mode: reconnect with `auth: { token }` |
| `TOKEN_EXPIRED` | The connection's token has expired since it connected: refresh, reconnect, retry |
| `NOT_PARTICIPANT` | Not a participant of `conversationId`; nothing was stored or joined |
| `INVALID_PAYLOAD` | The payload was not an object, or (`field: "messageType"`) its `messageType` is missing or not one a client may send, or (`field: "attachments"`) a `STICKER` failed the [sticker check](#stickers); `_id` echoes the client's id |
| `MESSAGE_SEND_FAILED` | Storing the message failed (`message` says why); `_id` echoes the client's id |

### `SOCKET_AUTH_MODE`

What a legacy (tokenless) socket may do:

- `permissive` (default): everything it always could, trusting the `userId` /
  `senderId` in its payloads. Each event is logged as one JSON line:

  ```json
  {"msg":"legacy_socket","event":"SETUP","mode":"permissive","action":"allowed","socketId":"…","claimedUserId":"…","origin":"https://www.seemuehub.com"}
  ```

  `event` is `connect`, `SETUP`, `NEW_MESSAGE` or `NEW_GROUP_MESSAGE`.
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
`ATTACHMENT_COUNT`, `FILE_URL` or `FILE_NAME` for a sticker).

## Internal routes and `CHAT_INTERNAL_KEY`

Two routes are for seemuehub-backend only:

| Route | Sent by the backend when | What it does here |
| --- | --- | --- |
| `POST /orders` | an order moves a step (`conversation.service` `updateOrderStep`) | stores a message in the order's conversation as the order's sender, and emits `ORDER` to its participants |
| `POST /core-socket/payment` | IB Bank confirms a payment | emits `PAYMENT` to the payer |

Both require the shared `CHAT_INTERNAL_KEY` as `X-Internal-Key`
(`src/middleware/internal-key.ts`, compared timing-safe). A missing or wrong
key is a 401 and logs `{"msg":"internal_key_refused",...}`. While the key is
**not set here**, both stay open as they always were and every call logs
`{"msg":"internal_key_unset",...}`: that is what lets this deploy before the
backend sends the header.

Rollout:

1. Deploy the backend change that sends `X-Internal-Key` on every call to this
   service (seemuehub-backend#37). With no key configured it sends nothing.
2. Deploy this. Nothing changes yet; `internal_key_unset` lines show the calls.
3. Put a long random `CHAT_INTERNAL_KEY` in the **backend's** `ENV` secret and
   redeploy it. (Before this step, setting the key here would refuse the
   backend.)
4. Put the same value in **this service's** `ENV` secret and re-run the latest
   deploy. From now on both routes are closed to everyone but the backend.

Rolling back is removing the key here (step 4).

`PUT /message-status/read?conversationId=` marks a conversation read for the
caller, and only for a participant: anyone else gets the same 404 as a
conversation that does not exist.

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

Group messages are not pushed. They used to post a `"platform": "TAXI"` payload
to `NOTIFICATION_URL`, a leftover of the product this service was forked from;
that call is gone and `NOTIFICATION_URL` is no longer read.

To turn pushes on: deploy the backend endpoint (seemuehub-backend#33), set the
same `CHAT_INTERNAL_KEY` on both services (see the rollout above), then add
`BACKEND_URL` to this service's `ENV` and redeploy.
