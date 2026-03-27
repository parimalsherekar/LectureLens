import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function Home() {
  const navigate = useNavigate();
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');

  // Host: navigate to a "new" room — the room is created inside RoomPage
  const handleCreate = () => {
    navigate('/room/new?role=host');
  };

  // Participant: navigate to the room by code
  const handleJoin = () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return setError('Enter a room code');
    navigate(`/room/${code}?role=participant`);
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>SFU Video Call</h1>

        <button onClick={handleCreate} style={styles.primaryBtn}>
          Create Room (Host)
        </button>

        <div style={styles.divider}>or join an existing room</div>

        <input
          placeholder="Enter Room Code"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
          style={styles.input}
        />
        <button onClick={handleJoin} style={{ ...styles.primaryBtn, background: '#10b981' }}>
          Join Room
        </button>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    background: '#0f0f0f',
  },
  card: {
    background: '#1a1a1a',
    padding: '40px',
    borderRadius: '12px',
    width: '360px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    border: '1px solid #2a2a2a',
  },
  title: {
    fontSize: '24px',
    textAlign: 'center',
    marginBottom: '8px',
    color: '#fff',
  },
  primaryBtn: {
    width: '100%',
    padding: '12px',
  },
  divider: {
    textAlign: 'center',
    color: '#666',
    fontSize: '13px',
  },
  input: {
    width: '100%',
  },
};
