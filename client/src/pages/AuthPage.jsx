import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const API = 'http://localhost:3001';

export default function AuthPage() {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [tab, setTab]         = useState('login');   // 'login' | 'register'
  const [name, setName]       = useState('');
  const [email, setEmail]     = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const endpoint = tab === 'login' ? '/auth/login' : '/auth/register';
    const body = tab === 'login'
      ? { email, password }
      : { name, email, password };

    try {
      const res  = await fetch(`${API}${endpoint}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Something went wrong');
        return;
      }

      login(data.token, data.user);
      navigate('/');
    } catch {
      setError('Cannot reach server. Is it running?');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={s.page}>
      <div style={s.card}>
        {/* Logo */}
        <div style={s.logoRow}>
          <div style={s.logoIcon}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
            </svg>
          </div>
          <span style={s.logoText}>LectureLens</span>
        </div>

        {/* Tabs */}
        <div style={s.tabs}>
          <button
            style={tab === 'login' ? s.tabActive : s.tab}
            onClick={() => { setTab('login'); setError(''); }}
          >
            Sign in
          </button>
          <button
            style={tab === 'register' ? s.tabActive : s.tab}
            onClick={() => { setTab('register'); setError(''); }}
          >
            Create account
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={s.form}>
          {tab === 'register' && (
            <div style={s.field}>
              <label style={s.label}>Name</label>
              <input
                style={s.input}
                type="text"
                placeholder="Your full name"
                value={name}
                onChange={e => setName(e.target.value)}
                required
                autoComplete="name"
              />
            </div>
          )}

          <div style={s.field}>
            <label style={s.label}>Email</label>
            <input
              style={s.input}
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div style={s.field}>
            <label style={s.label}>Password</label>
            <input
              style={s.input}
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
            />
          </div>

          {error && <p style={s.error}>{error}</p>}

          <button style={s.submit} type="submit" disabled={loading}>
            {loading
              ? 'Please wait…'
              : tab === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}

const s = {
  page: {
    minHeight: '100vh',
    background: '#202124',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: "'Google Sans', Roboto, system-ui, sans-serif",
  },
  card: {
    background: '#2d2f31',
    border: '1px solid #3c4043',
    borderRadius: 16,
    padding: '36px 40px',
    width: '100%',
    maxWidth: 400,
  },
  logoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 28,
  },
  logoIcon: {
    width: 36, height: 36, borderRadius: 8,
    background: '#8ab4f8', color: '#202124',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  logoText: { fontSize: 20, fontWeight: 400, color: '#e8eaed' },
  tabs: {
    display: 'flex',
    borderBottom: '1px solid #3c4043',
    marginBottom: 24,
  },
  tab: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    padding: '8px 0',
    color: '#9aa0a6',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  tabActive: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid #8ab4f8',
    padding: '8px 0',
    color: '#8ab4f8',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: {
    fontSize: 13,
    color: '#9aa0a6',
    fontWeight: 500,
  },
  input: {
    background: '#202124',
    border: '1px solid #5f6368',
    borderRadius: 8,
    padding: '10px 14px',
    color: '#e8eaed',
    fontSize: 14,
    outline: 'none',
    fontFamily: 'inherit',
  },
  error: {
    color: '#f28b82',
    fontSize: 13,
    margin: 0,
  },
  submit: {
    background: '#8ab4f8',
    color: '#202124',
    border: 'none',
    borderRadius: 24,
    padding: '12px',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 4,
    fontFamily: 'inherit',
  },
};
