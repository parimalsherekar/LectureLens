import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/* ── SVG Icons ─────────────────────────────────────────────────── */
const VideoIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
  </svg>
);
const LinkIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M11 17H7c-2.76 0-5-2.24-5-5s2.24-5 5-5h4v2H7c-1.65 0-3 1.35-3 3s1.35 3 3 3h4v2zm1-4H8v-2h8v2zm3-6h-4v2h4c1.65 0 3 1.35 3 3s-1.35 3-3 3h-4v2h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>
  </svg>
);
const ShieldIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>
  </svg>
);
const CaptionIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 4H5C3.89 4 3 4.9 3 6v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/>
  </svg>
);

export default function Home() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');

  const handleCreate = () => navigate('/room/new?role=host');
  const handleJoin = () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return setError('Enter a room code or link');
    navigate(`/room/${code}?role=participant`);
  };

  return (
    <div style={s.page}>
      {/* ── Top nav ── */}
      <header style={s.header}>
        <div style={s.logo}>
          <div style={s.logoIcon}><VideoIcon /></div>
          <span style={s.logoText}>LectureLens</span>
        </div>
        <div style={s.headerRight}>
          <span style={s.userName}>{user?.name}</span>
          <button style={s.meetingsBtn} onClick={() => navigate('/meetings')}>My Meetings</button>
          <button style={s.logoutBtn} onClick={logout}>Sign out</button>
        </div>
      </header>

      {/* ── Hero ── */}
      <main style={s.main}>
        <div style={s.left}>
          <h1 style={s.headline}>Video calls and meetings,<br />built for every lecture</h1>
          <p style={s.subline}>
            Connect with students in real time. Record, transcribe, and share your lectures automatically — no extra setup required.
          </p>

          <div style={s.actions}>
            <button style={s.newBtn} onClick={handleCreate}>
              <VideoIcon />
              New meeting
            </button>

            <div style={s.joinWrap}>
              <div style={s.joinField}>
                <span style={s.joinIcon}><LinkIcon /></span>
                <input
                  style={s.joinInput}
                  placeholder="Enter a code or link"
                  value={joinCode}
                  onChange={e => { setJoinCode(e.target.value); setError(''); }}
                  onKeyDown={e => e.key === 'Enter' && handleJoin()}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <button
                style={joinCode.trim() ? s.joinBtnActive : s.joinBtn}
                onClick={handleJoin}
                disabled={!joinCode.trim()}
              >
                Join
              </button>
            </div>
          </div>

          {error && <p style={s.error}>{error}</p>}

          <hr style={s.rule} />
          <p style={s.hint}>
            <a href="#" style={s.hintLink}>Learn more</a> about LectureLens
          </p>
        </div>

        {/* ── Mock video preview ── */}
        <div style={s.right}>
          <MockPreview />
        </div>
      </main>

      {/* ── Feature strip ── */}
      <section style={s.strip}>
        {[
          { Icon: VideoIcon,   color: '#8ab4f8', title: 'HD video & audio',        body: 'Crisp, reliable video for lectures of any size.' },
          { Icon: CaptionIcon, color: '#81c995', title: 'Live AI transcription',   body: 'Every word captured automatically as you teach.' },
          { Icon: ShieldIcon,  color: '#f28b82', title: 'Private room codes',      body: 'Secure sessions — only invited students join.' },
        ].map(({ Icon, color, title, body }) => (
          <div key={title} style={s.card}>
            <span style={{ color }}><Icon /></span>
            <p style={s.cardTitle}>{title}</p>
            <p style={s.cardBody}>{body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

/* Mock video preview illustration */
function MockPreview() {
  const tiles = [
    { label: 'Dr. Smith (Host)', top: '6%',  left: '4%',  w: '54%', h: '46%' },
    { label: 'Student A',        top: '6%',  left: '61%', w: '35%', h: '31%' },
    { label: 'Student B',        top: '40%', left: '61%', w: '35%', h: '31%' },
    { label: 'Student C',        top: '55%', left: '4%',  w: '35%', h: '31%' },
    { label: 'You',              top: '55%', left: '42%', w: '16%', h: '31%' },
  ];
  return (
    <div style={s.preview}>
      {tiles.map(t => (
        <div key={t.label} style={{ position:'absolute', top:t.top, left:t.left, width:t.w, height:t.h, background:'#3c4043', borderRadius:10, border:'1px solid #5f6368', overflow:'hidden', display:'flex', alignItems:'flex-end' }}>
          <span style={{ fontSize:9, color:'#e8eaed', background:'rgba(0,0,0,.55)', padding:'2px 7px', width:'100%', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{t.label}</span>
        </div>
      ))}
      {/* Mock control bar */}
      <div style={{ position:'absolute', bottom:0, left:0, right:0, height:38, background:'rgba(32,33,36,.95)', borderTop:'1px solid #3c4043', display:'flex', alignItems:'center', justifyContent:'center', gap:10 }}>
        {['#ea4335','#3c4043','#3c4043','#3c4043'].map((bg,i)=>(
          <div key={i} style={{ width:22, height:22, borderRadius:'50%', background:bg }} />
        ))}
        <div style={{ width:44, height:22, borderRadius:11, background:'#ea4335', marginLeft:16 }} />
      </div>
    </div>
  );
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
    padding: '14px 32px',
    borderBottom: '1px solid #3c4043',
  },
  headerRight: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 },
  userName: { fontSize: 14, color: '#9aa0a6' },
  meetingsBtn: {
    background: 'transparent', border: '1px solid #8ab4f8',
    color: '#8ab4f8', borderRadius: 20, padding: '6px 16px',
    fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
  },
  logoutBtn: {
    background: 'transparent', border: '1px solid #5f6368',
    color: '#9aa0a6', borderRadius: 20, padding: '6px 16px',
    fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
  },
  logo: { display:'flex', alignItems:'center', gap:10 },
  logoIcon: {
    width: 40, height: 40, borderRadius: 10,
    background: '#8ab4f8', color: '#202124',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  logoText: { fontSize: 22, fontWeight: 400, color: '#e8eaed', letterSpacing: '-0.01em' },

  main: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 72,
    padding: '60px 48px',
    flexWrap: 'wrap',
  },
  left: { flex: '0 0 auto', maxWidth: 480 },

  headline: {
    fontSize: 46,
    fontWeight: 400,
    lineHeight: 1.18,
    color: '#e8eaed',
    letterSpacing: '-0.025em',
    marginBottom: 20,
  },
  subline: {
    fontSize: 16,
    color: '#9aa0a6',
    lineHeight: 1.65,
    maxWidth: 420,
    marginBottom: 36,
  },

  actions: { display:'flex', flexDirection:'column', gap:16, alignItems:'flex-start' },

  newBtn: {
    display: 'flex', alignItems: 'center', gap: 10,
    background: '#8ab4f8', color: '#202124',
    border: 'none', borderRadius: 24,
    padding: '12px 22px', fontSize: 15, fontWeight: 600,
    cursor: 'pointer',
  },

  joinWrap: { display:'flex', alignItems:'center', gap:10 },
  joinField: {
    display: 'flex', alignItems: 'center', gap: 10,
    background: 'transparent',
    border: '1px solid #5f6368',
    borderRadius: 24, padding: '10px 18px', width: 270,
  },
  joinIcon: { color: '#9aa0a6', display:'flex', flexShrink:0 },
  joinInput: {
    background: 'transparent', border: 'none',
    color: '#e8eaed', fontSize: 15, outline: 'none',
    width: '100%', fontFamily: 'inherit',
  },
  joinBtn: {
    background: 'transparent', border: 'none',
    color: '#9aa0a6', borderRadius: 24,
    padding: '10px 20px', fontSize: 15, fontWeight: 600,
    cursor: 'not-allowed',
  },
  joinBtnActive: {
    background: 'transparent', border: 'none',
    color: '#8ab4f8', borderRadius: 24,
    padding: '10px 20px', fontSize: 15, fontWeight: 600,
    cursor: 'pointer',
  },

  error: { color: '#f28b82', fontSize: 13, marginTop: 6 },
  rule: { border: 'none', borderTop: '1px solid #3c4043', margin: '28px 0 18px' },
  hint: { fontSize: 14, color: '#9aa0a6' },
  hintLink: { color: '#8ab4f8', textDecoration: 'none' },

  right: { flex: '0 0 auto', width: '100%', maxWidth: 460 },
  preview: {
    position: 'relative', width: '100%', aspectRatio: '4/3',
    background: '#2d2f31', borderRadius: 16,
    border: '1px solid #3c4043', overflow: 'hidden',
  },

  strip: {
    display: 'flex', justifyContent: 'center',
    gap: 20, padding: '40px 48px 56px',
    borderTop: '1px solid #3c4043', flexWrap: 'wrap',
  },
  card: {
    background: '#2d2f31', border: '1px solid #3c4043',
    borderRadius: 14, padding: '24px 22px',
    width: 210, display: 'flex', flexDirection: 'column', gap: 8,
  },
  cardTitle: { fontSize: 15, fontWeight: 600, color: '#e8eaed', margin: 0 },
  cardBody:  { fontSize: 13, color: '#9aa0a6', lineHeight: 1.6, margin: 0 },
};
