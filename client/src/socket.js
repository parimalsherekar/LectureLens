import { io } from 'socket.io-client';

// Single Socket.IO instance shared across the app
const socket = io('http://localhost:3001', {
  autoConnect: true,
  transports: ['websocket'],
});

export default socket;
