import React, { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useMediasoup } from '../hooks/useMediasoup';
import { useTranscript } from '../hooks/useTranscript';

/** Renders a single video tile from a MediaStream */
function VideoTile({ stream, muted = false, label }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div style={styles.tile}>
      <video ref={videoRef} autoPlay playsInline muted={muted} style={styles.video} />
      <span style={styles.label}>{label}</span>
    </div>
  );
}

/** Invisible element that plays a remote audio stream */
function AudioPlayer({ stream }) {
  const audioRef = useRef(null);

  useEffect(() => {
    if (audioRef.current && stream) {
      audioRef.current.srcObject = stream;
    }
  }, [stream]);

  return <audio ref={audioRef} autoPlay />;
}

export default function RoomPage() {
  const { roomId: roomIdParam } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const role = searchParams.get('role') || 'participant';

  const { roomId, localStream, remoteStreams, messages, sendMessage, status, error, join,
          micEnabled, cameraEnabled, toggleMic, toggleCamera } =
    useMediasoup({ roomId: roomIdParam, role });

  const {
    segments,
    isRecording,
    transcriptStatus,
    startTranscription,
    stopTranscription,
    fetchTranscript,
  } = useTranscript({ roomId: roomId || roomIdParam, role, localStream });

  const [chatInput, setChatInput] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);
  const messagesEndRef = useRef(null);
  const transcriptEndRef = useRef(null);

  // Kick off signaling on mount
  useEffect(() => {
    join();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll chat to bottom on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-scroll transcript to bottom on new segment
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments]);

  const handleSend = () => {
    sendMessage(chatInput);
    setChatInput('');
  };

  const remoteEntries = Object.entries(remoteStreams);
  const displayRoomId = roomId || (roomIdParam !== 'new' ? roomIdParam : '…');

  return (
    <div style={styles.page}>
      {/* ── Header ────────────────────────────────────────────────── */}
      <div style={styles.header}>
        {/* Brand */}
        <span style={styles.brand}>
          <span style={styles.brandDot} />
          LectureLens
        </span>

        <span style={styles.headerDivider} />

        <span style={styles.roomCode}>{displayRoomId}</span>
        <span style={styles.roleTag}>{role === 'host' ? 'Host' : 'Participant'}</span>
        <span style={styles.statusDot(status)} title={status} />

        <button onClick={toggleMic} style={styles.controlBtn(micEnabled)} title={micEnabled ? 'Mute mic' : 'Unmute mic'}>
          {micEnabled ? 'Mic On' : 'Muted'}
        </button>
        <button onClick={toggleCamera} style={styles.controlBtn(cameraEnabled)} title={cameraEnabled ? 'Turn off camera' : 'Turn on camera'}>
          {cameraEnabled ? 'Cam On' : 'Cam Off'}
        </button>

        {/* Transcript controls — host only */}
        {role === 'host' && status === 'connected' && (
          <>
            {!isRecording ? (
              <button onClick={startTranscription} style={styles.transcriptBtn(false)}>
                Start Transcript
              </button>
            ) : (
              <button onClick={stopTranscription} style={styles.transcriptBtn(true)}>
                Stop Transcript
              </button>
            )}
          </>
        )}

        {/* Toggle transcript panel */}
        <button
          onClick={() => {
            if (!showTranscript && role === 'participant') fetchTranscript();
            setShowTranscript((v) => !v);
          }}
          style={styles.controlBtn(showTranscript)}
          title="Toggle transcript"
        >
          Transcript
        </button>

        <button onClick={() => navigate('/')} style={styles.leaveBtn}>
          Leave
        </button>
      </div>

      {/* ── Error banner ──────────────────────────────────────────── */}
      {error && <div style={styles.errorBanner}>Error: {error}</div>}

      {/* ── Connecting overlay ────────────────────────────────────── */}
      {status === 'connecting' && (
        <div style={styles.overlay}>Connecting…</div>
      )}

      {/* ── Hidden audio players for remote audio streams ─────────── */}
      {remoteEntries
        .filter(([, stream]) => stream.getVideoTracks().length === 0)
        .map(([key, stream]) => (
          <AudioPlayer key={key} stream={stream} />
        ))}

      {/* ── Main content: video grid + chat ───────────────────────── */}
      <div style={styles.main}>
        {/* Video grid */}
        <div style={styles.grid}>
          {localStream && (
            <VideoTile stream={localStream} muted label={`You (${role})`} />
          )}

          {remoteEntries
            .filter(([, stream]) => stream.getVideoTracks().length > 0)
            .map(([key, stream]) => (
              <VideoTile
                key={key}
                stream={stream}
                label={`Peer · ${key.split('_')[0].slice(0, 6)}`}
              />
            ))}

          {status === 'connected' && remoteEntries.length === 0 && (
            <div style={styles.waiting}>Waiting for others to join…</div>
          )}
        </div>

        {/* Transcript panel */}
        {showTranscript && (
          <div style={styles.transcript}>
            <div style={styles.transcriptHeader}>
              Transcript
              {role === 'host' && isRecording && (
                <span style={styles.recordingDot} title="Recording" />
              )}
              {transcriptStatus === 'complete' && (
                <span style={styles.completeBadge}>Complete</span>
              )}
            </div>

            <div style={styles.transcriptBody}>
              {role === 'participant' && transcriptStatus !== 'complete' && segments.length === 0 && (
                <div style={styles.transcriptEmpty}>
                  Transcript will be available after the meeting ends.
                </div>
              )}

              {segments.length === 0 && role === 'host' && (
                <div style={styles.transcriptEmpty}>
                  {isRecording
                    ? 'Waiting for first audio chunk…'
                    : 'Press "Start Transcript" to begin recording.'}
                </div>
              )}

              {segments.map((seg) => (
                <div key={seg.id} style={styles.segment}>
                  <span style={styles.segTime}>
                    {formatOffset(seg.startOffset)}
                  </span>
                  <span style={seg.status === 'pending' ? styles.segPending : styles.segText}>
                    {seg.text || '[ waiting for transcript… ]'}
                  </span>
                </div>
              ))}

              <div ref={transcriptEndRef} />
            </div>
          </div>
        )}

        {/* Chat panel */}
        <div style={styles.chat}>
          <div style={styles.chatHeader}>Chat</div>
          <div style={styles.chatMessages}>
            {messages.map((msg, i) => (
              <div
                key={i}
                style={msg.peerId === 'self' ? styles.msgSelf : styles.msgOther}
              >
                {msg.peerId !== 'self' && (
                  <span style={styles.msgPeer}>{msg.peerId.slice(0, 6)}</span>
                )}
                <span style={styles.msgText}>{msg.message}</span>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          <div style={styles.chatInputRow}>
            <input
              style={styles.chatInput}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Type a message…"
            />
            <button style={styles.sendBtn} onClick={handleSend}>
              Send
            </button>
          </div>
        </div>
      </div>

      {/* ── Share hint (host only) ────────────────────────────────── */}
      {status === 'connected' && role === 'host' && roomId && (
        <div style={styles.shareHint}>
          Invite with room code: <strong style={{ color: '#fff' }}>{roomId}</strong>
        </div>
      )}
    </div>
  );
}

/** Format seconds offset → "0:05", "1:23" */
function formatOffset(seconds) {
  if (seconds == null) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: 'var(--surface-1)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 20px',
    background: 'var(--surface-2)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    fontWeight: 700,
    fontSize: '16px',
    color: 'var(--text)',
    letterSpacing: '-0.01em',
    flexShrink: 0,
  },
  brandDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--brand)',
    flexShrink: 0,
  },
  headerDivider: {
    width: '1px',
    height: '20px',
    background: 'var(--border)',
    flexShrink: 0,
    margin: '0 2px',
  },
  roomCode: {
    fontWeight: 600,
    letterSpacing: '0.08em',
    color: 'var(--text-muted)',
    fontFamily: 'monospace',
    fontSize: '13px',
    background: 'var(--surface-3)',
    padding: '3px 8px',
    borderRadius: '4px',
  },
  roleTag: {
    background: 'var(--brand)',
    color: '#fff',
    padding: '2px 10px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.02em',
  },
  statusDot: (status) => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background:
      status === 'connected' ? 'var(--success)'
      : status === 'error' ? 'var(--danger)'
      : '#facc15',
    flexShrink: 0,
  }),
  controlBtn: (active) => ({
    background: active ? 'var(--surface-3)' : 'var(--danger)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    padding: '5px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    color: '#fff',
    fontWeight: 600,
  }),
  leaveBtn: {
    marginLeft: 'auto',
    background: 'var(--danger)',
    padding: '5px 14px',
    fontSize: '13px',
    borderRadius: '6px',
  },
  errorBanner: {
    background: '#450a0a',
    color: '#fca5a5',
    padding: '10px 20px',
    fontSize: '13px',
    flexShrink: 0,
  },
  overlay: {
    textAlign: 'center',
    padding: '60px',
    color: 'var(--text-muted)',
    fontSize: '15px',
  },
  main: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  grid: {
    flex: 1,
    display: 'flex',
    flexWrap: 'wrap',
    gap: '12px',
    padding: '20px',
    alignContent: 'flex-start',
    overflowY: 'auto',
  },
  tile: {
    position: 'relative',
    width: '320px',
    background: 'var(--surface-2)',
    borderRadius: '12px',
    overflow: 'hidden',
    border: '1px solid var(--border)',
  },
  video: {
    width: '100%',
    display: 'block',
    aspectRatio: '16/9',
    objectFit: 'cover',
    background: '#000',
  },
  label: {
    position: 'absolute',
    bottom: '8px',
    left: '10px',
    background: 'rgba(0,0,0,0.65)',
    color: '#fff',
    fontSize: '11px',
    padding: '2px 8px',
    borderRadius: '4px',
    fontWeight: 500,
  },
  waiting: {
    color: 'var(--text-muted)',
    padding: '40px',
    fontSize: '14px',
    alignSelf: 'center',
  },
  // ── Chat ──────────────────────────────────────────────────────────
  chat: {
    width: '280px',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--surface-2)',
    borderLeft: '1px solid var(--border)',
  },
  chatHeader: {
    padding: '12px 16px',
    fontWeight: 600,
    fontSize: '13px',
    color: 'var(--text-muted)',
    borderBottom: '1px solid var(--border)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  chatMessages: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  msgSelf: {
    alignSelf: 'flex-end',
    background: 'var(--brand)',
    color: '#fff',
    padding: '6px 10px',
    borderRadius: '12px 12px 2px 12px',
    maxWidth: '80%',
    fontSize: '13px',
    wordBreak: 'break-word',
  },
  msgOther: {
    alignSelf: 'flex-start',
    background: 'var(--surface-3)',
    color: 'var(--text)',
    padding: '6px 10px',
    borderRadius: '12px 12px 12px 2px',
    maxWidth: '80%',
    fontSize: '13px',
    wordBreak: 'break-word',
  },
  msgPeer: {
    display: 'block',
    fontSize: '10px',
    color: 'var(--text-muted)',
    marginBottom: '2px',
  },
  msgText: {
    display: 'block',
  },
  chatInputRow: {
    display: 'flex',
    gap: '6px',
    padding: '10px',
    borderTop: '1px solid var(--border)',
  },
  chatInput: {
    flex: 1,
    background: 'var(--surface-3)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    padding: '6px 10px',
    color: 'var(--text)',
    fontSize: '13px',
    outline: 'none',
  },
  sendBtn: {
    background: 'var(--brand)',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    padding: '6px 12px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  shareHint: {
    textAlign: 'center',
    padding: '10px',
    background: 'var(--surface-2)',
    color: 'var(--text-muted)',
    fontSize: '13px',
    borderTop: '1px solid var(--border)',
    flexShrink: 0,
  },
  // ── Transcript panel ────────────────────────────────────────────────
  transcriptBtn: (active) => ({
    background: active ? 'var(--danger)' : '#0d9488',
    border: 'none',
    borderRadius: '6px',
    padding: '5px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    color: '#fff',
    fontWeight: 600,
  }),
  transcript: {
    width: '300px',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--surface-1)',
    borderLeft: '1px solid var(--border)',
  },
  transcriptHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    fontWeight: 600,
    fontSize: '13px',
    color: 'var(--text-muted)',
    borderBottom: '1px solid var(--border)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--danger)',
    animation: 'pulse 1.5s ease-in-out infinite',
    flexShrink: 0,
  },
  completeBadge: {
    background: '#0d9488',
    color: '#fff',
    fontSize: '10px',
    padding: '2px 7px',
    borderRadius: '999px',
    fontWeight: 600,
  },
  transcriptBody: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  transcriptEmpty: {
    color: 'var(--text-muted)',
    fontSize: '13px',
    textAlign: 'center',
    marginTop: '20px',
    lineHeight: 1.6,
  },
  segment: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  segTime: {
    fontSize: '10px',
    color: 'var(--text-muted)',
    fontFamily: 'monospace',
  },
  segText: {
    fontSize: '13px',
    color: 'var(--text)',
    lineHeight: 1.6,
  },
  segPending: {
    fontSize: '13px',
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
};
