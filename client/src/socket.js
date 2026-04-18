import { io } from 'socket.io-client';

// Created with autoConnect:false — call connectSocket(token) after login
const socket = io('http://localhost:3001', {
  autoConnect: false,
  transports: ['websocket'],
});

export function connectSocket(token) {
  socket.auth = { token };
  if (!socket.connected) socket.connect();
}

export function disconnectSocket() {
  socket.disconnect();
}

export default socket;
