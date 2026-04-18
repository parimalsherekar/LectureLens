# LectureLens — Complete App Context

## Overview

LectureLens is a browser-based video conferencing platform built for lectures.
A **host** (lecturer) creates a room, students join with a room code, the host records
an AI-generated transcript, and after the meeting ends all participants can view
the transcript from their "My Meetings" dashboard.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, React Router v6, Vite |
| Realtime signaling | Socket.IO |
| WebRTC media | mediasoup (SFU) + mediasoup-client |
| Backend | Node.js, Express |
| Database | MongoDB (Atlas) via Mongoose |
| Auth | JWT (jsonwebtoken) + bcryptjs |

---

## Project Structure

```
SFUmedia/
├── server/
│   ├── .env                        ← MONGO_URI, JWT_SECRET, PORT
│   └── src/
│       ├── server.js               ← Express + Socket.IO entry point
│       ├── db.js                   ← Mongoose connection
│       ├── mediasoupWorker.js      ← mediasoup worker init
│       ├── Room.js                 ← In-memory mediasoup Room class
│       ├── config.js               ← mediasoup codec/transport config
│       ├── models/
│       │   ├── User.js
│       │   ├── Meeting.js
│       │   └── Transcript.js
│       ├── routes/
│       │   └── auth.js             ← POST /auth/register, POST /auth/login
│       └── middleware/
│           └── authMiddleware.js   ← JWT verify for REST + Socket.IO
│
└── client/
    └── src/
        ├── main.jsx                ← React root, wraps in AuthProvider + BrowserRouter
        ├── App.jsx                 ← Routes + ProtectedRoute guard
        ├── socket.js               ← Socket.IO singleton (autoConnect: false)
        ├── context/
        │   └── AuthContext.jsx     ← JWT state, login(), logout(), connectSocket()
        ├── pages/
        │   ├── AuthPage.jsx        ← Login / Register UI  →  /auth
        │   ├── Home.jsx            ← Landing, create/join room  →  /
        │   ├── RoomPage.jsx        ← Live meeting UI  →  /room/:roomId
        │   └── MeetingsPage.jsx    ← Past meetings + transcripts  →  /meetings
        └── hooks/
            ├── useMediasoup.js     ← WebRTC producer/consumer logic
            └── useTranscript.js    ← Audio capture + transcript sync
```

---

## Database Schema (MongoDB)

### Collection: `users`

Stores registered accounts.

```
{
  _id:       ObjectId               (auto)
  name:      String   required
  email:     String   required  unique  lowercase
  password:  String   required          (bcrypt hash, never stored plain)
  createdAt: Date                   (auto — mongoose timestamps)
  updatedAt: Date                   (auto)
}

Indexes:
  email  — unique
```

---

### Collection: `meetings`

One document per room. Created when host creates a room, updated as
participants join and when the meeting ends.

```
{
  _id:          String   (the 8-char roomId, e.g. "A3F9B2C1")
  hostId:       ObjectId → users._id
  participants: [ObjectId → users._id]   (includes host; addToSet on join)
  status:       String   "active" | "ended"   default "active"
  endedAt:      Date     null until endTranscription fires
  createdAt:    Date     (auto)
  updatedAt:    Date     (auto)
}

Indexes:
  participants  — for fast access-control queries
```

**Access control rule:** a user may read a transcript only if their `_id`
appears in `meetings.participants` for that `roomId`.

---

### Collection: `transcripts`

One document per room. Created when host starts transcription, updated
every ~5 seconds as the host syncs segments, finalized when meeting ends.

```
{
  _id:          ObjectId            (auto)
  roomId:       String   unique     (matches meetings._id)
  fullText:     String              (concatenated transcript text)
  segments:     Array               (see Segment shape below)
  meetingStart: Number              (epoch ms — when startTranscription fired)
  meetingEnd:   Number | null       (epoch ms — set on endTranscription)
  status:       String   "live" | "complete"   default "live"
  createdAt:    Date     (auto)
  updatedAt:    Date     (auto)
}

Indexes:
  roomId  — unique
```

**Segment shape** (each element of `segments[]`):

```
{
  id:          Number    (sequential, 1-based)
  chunkIndex:  Number    (which 30-sec audio chunk; -1 for system segments)
  text:        String    (transcribed text, or debug marker)
  startOffset: Number | null   (seconds from meetingStart)
  endOffset:   Number | null
  timestamp:   Number    (epoch ms)
  status:      "processing" | "complete"
}
```

**Debug marker segment** appended automatically on `endTranscription`:

```json
{
  "id": <last + 1>,
  "chunkIndex": -1,
  "text": "--- TRANSCRIPT COMPLETED ---",
  "startOffset": null,
  "endOffset": null,
  "timestamp": <epoch ms>,
  "status": "complete"
}
```

---

## REST API

All protected routes require: `Authorization: Bearer <JWT>`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET    | /health | — | Server health check |
| POST   | /auth/register | — | Create account → returns `{ token, user }` |
| POST   | /auth/login | — | Sign in → returns `{ token, user }` |
| GET    | /meetings | ✓ | All meetings the user participated in |
| GET    | /transcript/:roomId | ✓ + participant | Full transcript (only if complete) |

### POST /auth/register  body: `{ name, email, password }`
### POST /auth/login     body: `{ email, password }`

Both return:
```json
{
  "token": "<JWT, expires 7d>",
  "user": { "id": "...", "name": "...", "email": "..." }
}
```

### GET /meetings  response: array of:
```json
{
  "roomId": "A3F9B2C1",
  "host": { "_id": "...", "name": "...", "email": "..." },
  "isHost": true,
  "status": "ended",
  "createdAt": "...",
  "endedAt": "...",
  "transcriptStatus": "complete"
}
```

### GET /transcript/:roomId  response: full Transcript document

---

## Socket.IO Events

The socket connects with a JWT in the auth handshake:
```js
socket.auth = { token: "<JWT>" };
socket.connect();
```

Server verifies the token before accepting any connection. `socket.user`
is available in all handlers with `{ userId, email, name }`.

### Client → Server

| Event | Payload | Response (callback) |
|-------|---------|---------------------|
| `createRoom` | `{}` | `{ roomId, rtpCapabilities }` |
| `joinRoom` | `{ roomId }` | `{ rtpCapabilities }` |
| `createTransport` | `{ direction }` | `{ transportParams }` |
| `connectTransport` | `{ transportId, dtlsParameters }` | `{ connected }` |
| `produce` | `{ transportId, kind, rtpParameters }` | `{ producerId }` |
| `consume` | `{ producerId, rtpCapabilities }` | `{ consumerParams }` |
| `resumeConsumer` | `{ consumerId }` | `{ resumed }` |
| `getProducers` | `{}` | `{ producers }` |
| `startTranscription` | `{ roomId }` | — |
| `syncTranscript` | `{ roomId, segments, fullText }` | — |
| `endTranscription` | `{ roomId }` | — |
| `getTranscript` | `{ roomId }` | Transcript doc or `{ error }` |
| `chatMessage` | `{ message }` | `{ sent }` |

### Server → Client (broadcast)

| Event | Payload | Trigger |
|-------|---------|---------|
| `peerJoined` | `{ peerId }` | Someone joins the room |
| `peerLeft` | `{ peerId }` | Someone disconnects |
| `newProducer` | `{ producerId, kind, peerId }` | Host starts producing media |
| `chatMessage` | `{ peerId, message, timestamp }` | Chat message sent |

---

## Complete Workflows

### 1. First-time Registration

```
User opens /  →  ProtectedRoute detects no JWT  →  redirect to /auth
User fills register form  →  POST /auth/register
Server: hash password, create users doc, sign JWT
Client: stores JWT + user in localStorage, calls connectSocket(token)
Socket connects with JWT in handshake  →  server verifies  →  accepted
User lands on /
```

### 2. Return Login

```
User opens /  →  AuthContext reads JWT from localStorage  →  connectSocket(token)
If JWT valid: lands on /
If JWT expired/missing: redirect to /auth  →  POST /auth/login  →  same as above
```

### 3. Host Creates a Meeting

```
Home → "New meeting"  →  navigate to /room/new?role=host
RoomPage mounts  →  useMediasoup.join()  →  socket.emit("createRoom")

Server:
  - generates 8-char roomId
  - creates in-memory mediasoup Room
  - inserts meetings doc: { _id: roomId, hostId, participants: [hostId] }
  - returns { roomId, rtpCapabilities }

Client:
  - creates send + recv WebRTC transports
  - captures mic + camera  →  produce audio + video
  - shows room code in header for sharing
```

### 4. Participant Joins

```
Home → enters room code → "Join"  →  navigate to /room/<code>?role=participant
RoomPage mounts  →  socket.emit("joinRoom", { roomId })

Server:
  - finds in-memory Room
  - Meeting.findByIdAndUpdate: $addToSet participants with userId
  - broadcasts "peerJoined" to existing peers
  - returns rtpCapabilities

Client:
  - creates recv transport
  - socket.emit("getProducers")  →  consume each existing producer
  - remote video/audio streams appear
```

### 5. Live Transcription (Host only)

```
Host clicks "Start Transcript"
  →  useTranscript.startTranscription()
  →  socket.emit("startTranscription", { roomId })
  →  Server: creates transcripts doc with status="live"

Every 30s: MediaRecorder fires ondataavailable with audio Blob
  →  placeholder segment added to local state (status: "processing")
  →  [INTEGRATION POINT] blob sent to LLM server (not yet built)
  →  LLM server responds with { text, startOffset, endOffset, chunkIndex }
  →  placeholder replaced with real text

Every 5s: socket.emit("syncTranscript", { roomId, segments, fullText })
  →  Server: Transcript.findOneAndUpdate (upserts segments + fullText)

Host clicks "Stop Transcript"
  →  MediaRecorder stops  →  final sync
  →  socket.emit("endTranscription", { roomId })

Server on endTranscription:
  - appends "--- TRANSCRIPT COMPLETED ---" debug segment
  - sets transcript status="complete", meetingEnd=now
  - sets meeting status="ended", endedAt=now
```

### 6. Participant Views Live Transcript Panel

```
Participant clicks "Transcript" in room header
  →  fetchTranscript()  →  socket.emit("getTranscript", { roomId })

Server:
  - checks Meeting.participants contains socket.user.userId  →  403 if not
  - checks transcript.status === "complete"  →  error if still live
  - returns transcript doc

While meeting is live: transcript panel shows
  "Transcript will be available after the meeting ends."
After meeting ends: segments display with timestamps
```

### 7. Post-Meeting — My Meetings Dashboard

```
User clicks "My Meetings" on Home
  →  navigate to /meetings
  →  MeetingsPage mounts  →  GET /meetings (Authorization: Bearer <JWT>)

Server:
  - Meeting.find({ participants: userId }).populate("hostId").sort(-createdAt)
  - for each meeting, looks up transcript status
  - returns list with { roomId, host, isHost, status, createdAt, endedAt, transcriptStatus }

UI shows each meeting as a card:
  - room code, date, duration, host name
  - badge: "Host" if isHost, "Ended"/"Live" for status
  - "View Transcript" button appears only when transcriptStatus === "complete"

User clicks "View Transcript"
  →  GET /transcript/:roomId (Authorization: Bearer <JWT>)

Server:
  - Meeting.findOne({ _id: roomId, participants: userId })  →  403 if not participant
  - returns full transcript doc

UI expands transcript inline:
  - segments with timestamps
  - "--- TRANSCRIPT COMPLETED ---" shown in green monospace (debug marker)
  - full concatenated text shown below
```

### 8. Sign Out

```
User clicks "Sign out"
  →  logout() in AuthContext
  →  clears localStorage (token + user)
  →  socket.disconnect()
  →  navigate to /auth (via ProtectedRoute redirect)
```

---

## Security Model

| Concern | How it's handled |
|---------|-----------------|
| Password storage | bcrypt hash (cost 10), plain text never stored |
| Session | JWT signed with JWT_SECRET, 7-day expiry |
| Socket auth | Every socket connection requires valid JWT in handshake |
| Transcript access | Server checks `meetings.participants` contains userId before returning any transcript data |
| Route protection | Client-side ProtectedRoute redirects to /auth; server independently verifies on every request |

---

## Environment Variables (server/.env)

```
MONGO_URI=<MongoDB Atlas connection string>
JWT_SECRET=<long random secret — never commit the real value>
PORT=3001
```

---

## What Is Not Yet Built

| Feature | Notes |
|---------|-------|
| LLM transcription server | Placeholder integration points exist in `useTranscript.js` — wire real Whisper/LLM socket there |
| Token refresh | JWT expires after 7 days; no refresh token flow yet |
| Password reset | No forgot-password flow |
| Participant count / names in meeting | Participants stored as ObjectIds; use `.populate()` to get names |
