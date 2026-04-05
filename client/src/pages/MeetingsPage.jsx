import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const API = 'http://localhost:3001';

export default function MeetingsPage() {
  const { token, user, logout } = useAuth();
  const navigate = useNavigate();

  const [meetings, setMeetings]         = useState([]);
  const [loadingList, setLoadingList]   = useState(true);
  const [error, setError]               = useState('');

  // roomId → { loading, data, error }
  const [transcripts, setTranscripts]   = useState({});

  useEffect(() => {
    fetch(`${API}/meetings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) setError(data.error);
        else setMeetings(data);
      })
      .catch(() => setError('Could not load meetings'))
      .finally(() => setLoadingList(false));
  }, [token]);

  async function fetchTranscript(roomId) {
    // Toggle off if already loaded
    if (transcripts[roomId]?.data) {
      setTranscripts(t => ({ ...t, [roomId]: undefined }));
      return;
    }

    setTranscripts(t => ({ ...t, [roomId]: { loading: true } }));
    try {
      const res  = await fetch(`${API}/transcript/${roomId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setTranscripts(t => ({ ...t, [roomId]: { error: data.error } }));
      } else {
        setTranscripts(t => ({ ...t, [roomId]: { data } }));
      }
    } catch {
      setTranscripts(t => ({ ...t, [roomId]: { error: 'Failed to load transcript' } }));
    }
  }

  return (
    <div style={s.page}>
      {/* Header */}
      <header style={s.header}>
        <button style={s.backBtn} onClick={() => navigate('/')}>
          ← Back
        </button>
        <div style={s.logo}>
          <div style={s.logoIcon}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
            </svg>
          </div>
          <span style={s.logoText}>LectureLens</span>
        </div>
        <span style={s.userName}>{user?.name}</span>
        <button style={s.logoutBtn} onClick={logout}>Sign out</button>
      </header>

      {/* Content */}
      <main style={s.main}>
        <h1 style={s.heading}>My Meetings</h1>

        {loadingList && <p style={s.muted}>Loading…</p>}
        {error       && <p style={s.errorText}>{error}</p>}

        {!loadingList && !error && meetings.length === 0 && (
          <p style={s.muted}>You have not joined any meetings yet.</p>
        )}

        <div style={s.list}>
          {meetings.map(m => {
            const ts     = transcripts[m.roomId];
            const isOpen = !!ts?.data;

            return (
              <div key={m.roomId} style={s.card}>
                {/* Meeting info row */}
                <div style={s.cardTop}>
                  <div style={s.cardLeft}>
                    <span style={s.roomCode}>{m.roomId}</span>
                    {m.isHost && <span style={s.hostBadge}>Host</span>}
                    <span style={m.status === 'ended' ? s.badgeEnded : s.badgeLive}>
                      {m.status === 'ended' ? 'Ended' : 'Live'}
                    </span>
                  </div>
                  <div style={s.cardRight}>
                    <span style={s.meta}>
                      {new Date(m.createdAt).toLocaleString()}
                    </span>
                    {m.endedAt && (
                      <span style={s.meta}>
                        Duration: {formatDuration(m.createdAt, m.endedAt)}
                      </span>
                    )}
                    <span style={s.meta}>
                      Host: {m.isHost ? 'You' : m.host?.name}
                    </span>
                  </div>
                </div>

                {/* Transcript button */}
                <div style={s.cardActions}>
                  {m.transcriptStatus === 'complete' ? (
                    <button
                      style={isOpen ? s.btnSecondary : s.btnPrimary}
                      onClick={() => fetchTranscript(m.roomId)}
                    >
                      {ts?.loading
                        ? 'Loading…'
                        : isOpen
                        ? 'Hide Transcript'
                        : 'View Transcript'}
                    </button>
                  ) : (
                    <span style={s.noTranscript}>
                      {m.transcriptStatus === 'live'
                        ? 'Meeting in progress'
                        : 'No transcript available'}
                    </span>
                  )}
                </div>

                {/* Error */}
                {ts?.error && <p style={s.errorText}>{ts.error}</p>}

                {/* Transcript viewer */}
                {isOpen && (
                  <div style={s.transcriptBox}>
                    <div style={s.transcriptHeader}>
                      <span>Transcript</span>
                      <span style={s.segCount}>{ts.data.segments.length} segments</span>
                    </div>
                    <div style={s.transcriptBody}>
                      {ts.data.segments.map((seg, i) => (
                        <div key={i} style={s.segment}>
                          {seg.startOffset != null && (
                            <span style={s.segTime}>{formatOffset(seg.startOffset)}</span>
                          )}
                          <span style={
                            seg.text === '--- TRANSCRIPT COMPLETED ---'
                              ? s.segDebug
                              : s.segText
                          }>
                            {seg.text}
                          </span>
                        </div>
                      ))}
                    </div>
                    {ts.data.fullText && (
                      <>
                        <div style={s.fullTextLabel}>Full text</div>
                        <pre style={s.fullText}>{ts.data.fullText}</pre>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function formatDuration(start, end) {
  const mins = Math.round((new Date(end) - new Date(start)) / 60000);
  if (mins < 1)  return '< 1 min';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatOffset(seconds) {
  if (seconds == null) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const s = {
  page: {
    minHeight: '100vh',
    background: '#202124',
    color: '#e8eaed',
    fontFamily: "'Google Sans', Roboto, system-ui, sans-serif",
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '14px 32px',
    borderBottom: '1px solid #3c4043',
  },
  backBtn: {
    background: 'transparent',
    border: 'none',
    color: '#8ab4f8',
    fontSize: 14,
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: '4px 0',
  },
  logo: { display: 'flex', alignItems: 'center', gap: 8 },
  logoIcon: {
    width: 30, height: 30, borderRadius: 7,
    background: '#8ab4f8', color: '#202124',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  logoText: { fontSize: 18, fontWeight: 400, color: '#e8eaed' },
  userName:  { marginLeft: 'auto', fontSize: 14, color: '#9aa0a6' },
  logoutBtn: {
    background: 'transparent', border: '1px solid #5f6368',
    color: '#9aa0a6', borderRadius: 20, padding: '5px 14px',
    fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
  },
  main: {
    maxWidth: 860,
    width: '100%',
    margin: '0 auto',
    padding: '40px 24px',
  },
  heading: {
    fontSize: 28,
    fontWeight: 400,
    color: '#e8eaed',
    marginBottom: 28,
  },
  muted:     { color: '#9aa0a6', fontSize: 14 },
  errorText: { color: '#f28b82', fontSize: 13 },
  list: { display: 'flex', flexDirection: 'column', gap: 16 },

  card: {
    background: '#2d2f31',
    border: '1px solid #3c4043',
    borderRadius: 12,
    padding: '20px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  cardTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    gap: 10,
  },
  cardLeft:  { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  cardRight: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' },

  roomCode: {
    fontFamily: 'monospace',
    fontSize: 16,
    fontWeight: 600,
    color: '#e8eaed',
    letterSpacing: '0.08em',
    background: '#202124',
    padding: '3px 10px',
    borderRadius: 6,
  },
  hostBadge: {
    background: '#8ab4f8',
    color: '#202124',
    fontSize: 11,
    fontWeight: 700,
    padding: '2px 9px',
    borderRadius: 999,
  },
  badgeEnded: {
    background: '#3c4043',
    color: '#9aa0a6',
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 9px',
    borderRadius: 999,
  },
  badgeLive: {
    background: '#0d9488',
    color: '#fff',
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 9px',
    borderRadius: 999,
  },
  meta: { fontSize: 12, color: '#9aa0a6' },

  cardActions: { display: 'flex', alignItems: 'center', gap: 10 },
  btnPrimary: {
    background: '#0d9488',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '7px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnSecondary: {
    background: 'transparent',
    color: '#9aa0a6',
    border: '1px solid #5f6368',
    borderRadius: 8,
    padding: '7px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  noTranscript: { fontSize: 13, color: '#9aa0a6', fontStyle: 'italic' },

  transcriptBox: {
    background: '#202124',
    border: '1px solid #3c4043',
    borderRadius: 8,
    overflow: 'hidden',
  },
  transcriptHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 16px',
    borderBottom: '1px solid #3c4043',
    fontSize: 12,
    fontWeight: 600,
    color: '#9aa0a6',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  segCount: { fontWeight: 400 },
  transcriptBody: {
    maxHeight: 320,
    overflowY: 'auto',
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  segment: { display: 'flex', flexDirection: 'column', gap: 2 },
  segTime: { fontSize: 10, color: '#9aa0a6', fontFamily: 'monospace' },
  segText: { fontSize: 13, color: '#e8eaed', lineHeight: 1.6 },
  segDebug: {
    fontSize: 12,
    color: '#81c995',
    fontFamily: 'monospace',
    fontStyle: 'italic',
  },
  fullTextLabel: {
    padding: '8px 16px 4px',
    fontSize: 11,
    color: '#9aa0a6',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    borderTop: '1px solid #3c4043',
  },
  fullText: {
    margin: 0,
    padding: '0 16px 14px',
    fontSize: 12,
    color: '#9aa0a6',
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    lineHeight: 1.7,
    maxHeight: 160,
    overflowY: 'auto',
  },
};
