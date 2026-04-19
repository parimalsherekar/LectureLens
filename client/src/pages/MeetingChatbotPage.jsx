import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const API = 'http://localhost:3001';

async function readApiResponse(res) {
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    return res.json();
  }

  const text = await res.text();
  return {
    error: text.startsWith('<!DOCTYPE')
      ? 'The server returned HTML instead of JSON. Please make sure the SFU server was restarted after adding the chatbot endpoint.'
      : text || 'The server returned an unexpected response.',
  };
}

export default function MeetingChatbotPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { token, user, logout } = useAuth();

  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        'Ask anything about this meeting. I will answer using the saved transcript only.',
    },
  ]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState('');
  const [meetingInfo, setMeetingInfo] = useState(null);
  const endRef = useRef(null);

  useEffect(() => {
    fetch(`${API}/meetings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => readApiResponse(res))
      .then((data) => {
        if (Array.isArray(data)) {
          const selectedMeeting = data.find((meeting) => meeting.roomId === roomId);
          setMeetingInfo(selectedMeeting || null);
          if (!selectedMeeting) {
            setError('Meeting not found or not accessible.');
          } else if (selectedMeeting.transcriptStatus !== 'completed') {
            setError('Chatbot is available only after the transcript is completed.');
          }
        } else {
          setError(data.error || 'Could not load meeting details.');
        }
      })
      .catch(() => setError('Could not load meeting details.'));
  }, [roomId, token]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending]);

  async function handleSend() {
    const trimmedInput = input.trim();
    if (!trimmedInput || isSending) return;

    const nextUserMessage = { role: 'user', content: trimmedInput };
    const updatedMessages = [...messages, nextUserMessage];
    const history = updatedMessages
      .slice(1, -1)
      .filter((message) => message.content)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    setMessages(updatedMessages);
    setInput('');
    setError('');
    setIsSending(true);

    try {
      const res = await fetch(`${API}/meetings/${roomId}/chatbot`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: trimmedInput,
          history,
        }),
      });

      const data = await readApiResponse(res);
      if (!res.ok) {
        throw new Error(data.error || 'Failed to get chatbot response');
      }

      setMessages((current) => [
        ...current,
        { role: 'assistant', content: data.answer },
      ]);
    } catch (err) {
      setError(err.message || 'Failed to get chatbot response');
      setMessages((current) => current.filter((message, index) => {
        if (index !== current.length - 1) return true;
        return message !== nextUserMessage;
      }));
      setInput(trimmedInput);
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div style={s.page}>
      <header style={s.header}>
        <button style={s.backBtn} onClick={() => navigate('/meetings')}>
          ← Back
        </button>
        <div style={s.logo}>
          <div style={s.logoIcon}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
            </svg>
          </div>
          <span style={s.logoText}>LectureLens</span>
        </div>
        <span style={s.userName}>{user?.name}</span>
        <button style={s.logoutBtn} onClick={logout}>Sign out</button>
      </header>

      <main style={s.main}>
        <div style={s.hero}>
          <div>
            <h1 style={s.heading}>Meeting Chatbot</h1>
            <p style={s.subheading}>
              Ask questions about meeting <strong>{roomId}</strong> using its transcript.
            </p>
          </div>
          <div style={s.meetingMeta}>
            <span style={s.metaLabel}>Room</span>
            <span style={s.roomCode}>{roomId}</span>
            {meetingInfo?.host && (
              <span style={s.metaText}>
                Host: {meetingInfo.isHost ? 'You' : meetingInfo.host.name}
              </span>
            )}
          </div>
        </div>

        {error && <p style={s.errorText}>{error}</p>}

        <div style={s.chatShell}>
          <div style={s.chatBody}>
            {messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                style={message.role === 'assistant' ? s.assistantMessage : s.userMessage}
              >
                <span style={s.messageRole}>
                  {message.role === 'assistant' ? 'Meeting Bot' : 'You'}
                </span>
                <span style={s.messageText}>{message.content}</span>
              </div>
            ))}

            {isSending && (
              <div style={s.assistantMessage}>
                <span style={s.messageRole}>Meeting Bot</span>
                <span style={s.messageText}>Thinking…</span>
              </div>
            )}

            <div ref={endRef} />
          </div>

          <div style={s.chatComposer}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Ask a question about this meeting..."
              style={s.input}
              disabled={isSending || meetingInfo?.transcriptStatus !== 'completed'}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={isSending || !input.trim() || meetingInfo?.transcriptStatus !== 'completed'}
              style={s.sendBtn(isSending || !input.trim() || meetingInfo?.transcriptStatus !== 'completed')}
            >
              {isSending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

const s = {
  page: {
    minHeight: '100vh',
    background:
      'radial-gradient(circle at top left, rgba(13,148,136,0.18), transparent 28%), #202124',
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
    width: 30,
    height: 30,
    borderRadius: 7,
    background: '#8ab4f8',
    color: '#202124',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { fontSize: 18, fontWeight: 400, color: '#e8eaed' },
  userName: { marginLeft: 'auto', fontSize: 14, color: '#9aa0a6' },
  logoutBtn: {
    background: 'transparent',
    border: '1px solid #5f6368',
    color: '#9aa0a6',
    borderRadius: 20,
    padding: '5px 14px',
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  main: {
    maxWidth: 960,
    width: '100%',
    margin: '0 auto',
    padding: '32px 24px 40px',
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
    flex: 1,
  },
  hero: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 20,
    alignItems: 'flex-start',
    flexWrap: 'wrap',
  },
  heading: {
    margin: 0,
    fontSize: 30,
    fontWeight: 500,
  },
  subheading: {
    margin: '10px 0 0',
    color: '#9aa0a6',
    fontSize: 14,
    lineHeight: 1.6,
  },
  meetingMeta: {
    background: '#2d2f31',
    border: '1px solid #3c4043',
    borderRadius: 12,
    padding: '14px 16px',
    minWidth: 220,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  metaLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#9aa0a6',
  },
  roomCode: {
    fontFamily: 'monospace',
    fontSize: 17,
    fontWeight: 600,
    letterSpacing: '0.08em',
  },
  metaText: {
    fontSize: 13,
    color: '#9aa0a6',
  },
  errorText: {
    color: '#f28b82',
    fontSize: 13,
    margin: 0,
  },
  chatShell: {
    flex: 1,
    minHeight: 520,
    background: 'rgba(45, 47, 49, 0.92)',
    border: '1px solid #3c4043',
    borderRadius: 18,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 24px 50px rgba(0, 0, 0, 0.18)',
  },
  chatBody: {
    flex: 1,
    overflowY: 'auto',
    padding: '22px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    maxWidth: '82%',
    background: '#202124',
    border: '1px solid #3c4043',
    borderRadius: '16px 16px 16px 6px',
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  userMessage: {
    alignSelf: 'flex-end',
    maxWidth: '82%',
    background: '#0d9488',
    border: '1px solid rgba(13, 148, 136, 0.5)',
    borderRadius: '16px 16px 6px 16px',
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  messageRole: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: '#9aa0a6',
  },
  messageText: {
    fontSize: 14,
    lineHeight: 1.65,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  chatComposer: {
    borderTop: '1px solid #3c4043',
    padding: '16px',
    display: 'flex',
    gap: 12,
    background: '#26282a',
  },
  input: {
    flex: 1,
    minHeight: 72,
    resize: 'vertical',
    background: '#202124',
    border: '1px solid #4c5258',
    borderRadius: 12,
    color: '#e8eaed',
    padding: '12px 14px',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
  },
  sendBtn: (disabled) => ({
    alignSelf: 'flex-end',
    background: disabled ? '#3c4043' : '#0d9488',
    color: '#fff',
    border: 'none',
    borderRadius: 12,
    padding: '12px 20px',
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
  }),
};
