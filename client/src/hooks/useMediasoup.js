import { useEffect, useRef, useState, useCallback } from 'react';
import { Device } from 'mediasoup-client';
import socket from '../socket';

/**
 * useMediasoup — all WebRTC / mediasoup signaling in one place.
 *
 * For HOST  (roomId === 'new'):
 *   1. emit createRoom → receive roomId + routerRtpCapabilities
 *   2. Load Device
 *   3. getUserMedia
 *   4. Create recv transport (to receive future participants)
 *   5. Create send transport → produce audio + video
 *
 * For PARTICIPANT (roomId = actual code):
 *   1. emit joinRoom → receive routerRtpCapabilities
 *   2. Load Device
 *   3. getUserMedia
 *   4. Create recv transport
 *   5. Consume existing producers in room
 *   6. Listen for future newProducer events
 *
 * Extension points for transcript / LLM pipeline:
 *   - After producing, attach an AudioContext analyser to the audio track
 *   - After consuming, pipe the remote audio track to a STT service
 */
export function useMediasoup({ roomId: roomIdParam, role }) {
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const localStreamRef = useRef(null);

  const [roomId, setRoomId] = useState(roomIdParam === 'new' ? null : roomIdParam);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({}); // key → MediaStream
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);

  // ─── Promisified socket emit ───────────────────────────────────────────

  const emit = useCallback((event, data = {}) => {
    return new Promise((resolve) => {
      socket.emit(event, data, resolve);
    });
  }, []);

  // ─── Load mediasoup Device ────────────────────────────────────────────

  const loadDevice = useCallback(async (rtpCapabilities) => {
    const device = new Device();
    // Stores router codec info; needed before creating transports
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    deviceRef.current = device;
    return device;
  }, []);

  // ─── Create send transport + produce local tracks ─────────────────────

  const createSendTransport = useCallback(async (device, stream) => {
    const { transportParams, error: err } = await emit('createTransport', { direction: 'send' });
    if (err) throw new Error(err);

    const transport = device.createSendTransport(transportParams);
    sendTransportRef.current = transport;

    // Fires once on first produce() — establishes DTLS
    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        const res = await emit('connectTransport', {
          transportId: transport.id,
          dtlsParameters,
        });
        if (res?.error) throw new Error(res.error);
        callback();
      } catch (e) { errback(e); }
    });

    // Fires for each produce() call — server creates Producer
    transport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
      try {
        const { producerId, error: err } = await emit('produce', {
          transportId: transport.id,
          kind,
          rtpParameters,
        });
        if (err) throw new Error(err);
        callback({ id: producerId });
      } catch (e) { errback(e); }
    });

    // Produce video track
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) await transport.produce({ track: videoTrack });

    // Produce audio track
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) await transport.produce({ track: audioTrack });
  }, [emit]);

  // ─── Create recv transport ────────────────────────────────────────────

  const createRecvTransport = useCallback(async (device) => {
    const { transportParams, error: err } = await emit('createTransport', { direction: 'recv' });
    if (err) throw new Error(err);

    const transport = device.createRecvTransport(transportParams);
    recvTransportRef.current = transport;

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        const res = await emit('connectTransport', {
          transportId: transport.id,
          dtlsParameters,
        });
        if (res?.error) throw new Error(res.error);
        callback();
      } catch (e) { errback(e); }
    });

    return transport;
  }, [emit]);

  // ─── Consume one producer ─────────────────────────────────────────────

  const consumeProducer = useCallback(async ({ producerId, peerId }) => {
    const device = deviceRef.current;
    const transport = recvTransportRef.current;
    if (!device || !transport) return;

    const { consumerParams, error: err } = await emit('consume', {
      producerId,
      rtpCapabilities: device.rtpCapabilities,
    });
    if (err) {
      console.warn('[consume] Server error:', err);
      return;
    }

    // Create client-side consumer from server params
    const consumer = await transport.consume(consumerParams);

    // Server starts consumer paused — resume after client is ready
    await emit('resumeConsumer', { consumerId: consumer.id });

    const stream = new MediaStream([consumer.track]);
    // Key includes both peerId and producerId (one peer can have audio + video)
    const key = `${peerId}_${producerId}`;
    setRemoteStreams((prev) => ({ ...prev, [key]: stream }));

    console.log(`[Consumer] ${consumerParams.kind} from peer ${peerId}`);
  }, [emit]);

  // ─── Main join / init flow ────────────────────────────────────────────

  const join = useCallback(async () => {
    if (!role) return;
    setStatus('connecting');
    setError(null);

    try {
      // Reconnect if socket was disconnected from a previous room session
      if (!socket.connected) {
        socket.connect();
        await new Promise((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('connect_error', reject);
        });
      }
      let rtpCapabilities;
      let resolvedRoomId = roomIdParam;

      if (role === 'host') {
        // Create a new room on the server
        const res = await emit('createRoom');
        if (res.error) throw new Error(res.error);
        rtpCapabilities = res.rtpCapabilities;
        resolvedRoomId = res.roomId;
        setRoomId(resolvedRoomId);
      } else {
        // Join existing room
        const res = await emit('joinRoom', { roomId: roomIdParam });
        if (res.error) throw new Error(res.error);
        rtpCapabilities = res.rtpCapabilities;
      }

      // Load device with router's RTP capabilities
      const device = await loadDevice(rtpCapabilities);

      // Get local camera + mic
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      setLocalStream(stream);

      // Every peer needs a recv transport (to consume others)
      await createRecvTransport(device);

      // All peers send their own streams
      await createSendTransport(device, stream);

      // Consume producers already in the room when joining
      const { producers, error: pErr } = await emit('getProducers');
      if (pErr) throw new Error(pErr);
      for (const producer of producers) {
        await consumeProducer(producer);
      }

      setStatus('connected');
    } catch (err) {
      console.error('[useMediasoup] Init error:', err);
      setError(err.message);
      setStatus('error');
    }
  }, [role, roomIdParam, emit, loadDevice, createRecvTransport, createSendTransport, consumeProducer]);

  // ─── Mic / Camera toggles ─────────────────────────────────────────────

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.enabled = !audioTrack.enabled;
    setMicEnabled(audioTrack.enabled);
  }, []);

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;
    videoTrack.enabled = !videoTrack.enabled;
    setCameraEnabled(videoTrack.enabled);
  }, []);

  // ─── Send chat message ────────────────────────────────────────────────

  const sendMessage = useCallback((text) => {
    if (!text.trim()) return;
    setMessages((prev) => [...prev, { peerId: 'self', message: text, timestamp: Date.now() }]);
    socket.emit('chatMessage', { message: text });
  }, []);

  const leaveRoom = useCallback(async () => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    sendTransportRef.current?.close();
    recvTransportRef.current?.close();

    if (socket.connected) {
      await new Promise((resolve) => {
        socket.emit('leaveRoom', {}, () => resolve());
      });
      socket.disconnect();
    }

    setRemoteStreams({});
    setStatus('idle');
  }, []);

  // ─── Real-time: new producer / peer left / chat ───────────────────────

  useEffect(() => {
    const handleNewProducer = async ({ producerId, kind, peerId }) => {
      console.log(`[Socket] newProducer: ${kind} from ${peerId}`);
      await consumeProducer({ producerId, peerId });
    };

    const handlePeerLeft = ({ peerId }) => {
      setRemoteStreams((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${peerId}_`)) delete next[key];
        }
        return next;
      });
    };

    const handleChatMessage = ({ peerId, message, timestamp }) => {
      setMessages((prev) => [...prev, { peerId, message, timestamp }]);
    };

    socket.on('newProducer', handleNewProducer);
    socket.on('peerLeft', handlePeerLeft);
    socket.on('chatMessage', handleChatMessage);
    return () => {
      socket.off('newProducer', handleNewProducer);
      socket.off('peerLeft', handlePeerLeft);
      socket.off('chatMessage', handleChatMessage);
    };
  }, [consumeProducer]);

  // ─── Cleanup on unmount ───────────────────────────────────────────────

  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();
      // Disconnect so the server fires 'disconnect' → removePeer → peerLeft
      socket.disconnect();
    };
  }, []);

  return {
    roomId,        // resolved room ID (important for host: starts as null)
    localStream,
    remoteStreams,
    messages,
    sendMessage,
    status,
    error,
    join,
    leaveRoom,
    micEnabled,
    cameraEnabled,
    toggleMic,
    toggleCamera,
  };
}
