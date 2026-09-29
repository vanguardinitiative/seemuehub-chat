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
| `CHAT_INTERNAL_KEY` | recommended | When set, `/core-socket/*` requires it as `X-Internal-Key` |
| `SOCKET_AUTH_MODE` | no (`permissive`) | `permissive` or `enforce`; see below. Any other value stops the service at boot |
| `NOTIFICATION_URL` | no | Push notification endpoint for group messages |

In production these come from the `ENV` repository secret, which the deploy
writes to `.env` for `docker-compose.prod.yml` (`env_file: .env`). A changed
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

Fields a client cannot set on a message: `sender`, `actorUserId`,
`sendAsOrganizationId`, `isOrderMessage`, `orderId`, `orderStatus`,
`orderAction`, `isDeleted`, `deletedAt`, `deletedBy`, `deliveredAllAt`,
`readAllAt`. They are dropped.

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
| `INVALID_PAYLOAD` | The payload was not an object |
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
`message_refused` (NOT_PARTICIPANT).
