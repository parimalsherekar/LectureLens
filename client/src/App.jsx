import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import RoomPage from './pages/RoomPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/room/:roomId" element={<RoomPage />} />
    </Routes>
  );
}
