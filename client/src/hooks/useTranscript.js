import { useRef, useState, useCallback } from 'react';
import socket from '../socket';

// How often (ms) the host syncs transcript text to the SFU server
const SYNC_INTERVAL_MS = 5000;

// How often (ms) MediaRecorder produces an audio chunk → sent to LLM server
const CHUNK_INTERVAL_MS = 3000;

/**
 * useTranscript — manages host audio capture and transcript state.
 *
 * HOST flow:
 *   1. startTranscription() → opens MediaRecorder on host mic audio
 *   2. Every CHUNK_INTERVAL_MS → audio blob ready at INTEGRATION POINT A
 *   3. LLM server responds with text at INTEGRATION POINT B
 *   4. Every SYNC_INTERVAL_MS → syncs segments to SFU server
 *   5. stopTranscription() → final sync, marks transcript complete on SFU
 *
 * PARTICIPANT flow:
 *   1. fetchTranscript() → requests completed transcript from SFU server
 *
 * @param {{ roomId: string, role: string, localStream: MediaStream|null }} opts
 */
export function useTranscript({ roomId, role, localStream }) {
  const [segments, setSegments]               = useState([]);
  const [isRecording, setIsRecording]         = useState(false);
  const [transcriptStatus, setTranscriptStatus] = useState('idle'); // idle | live | complete

  const mediaRecorderRef  = useRef(null);
  const segmentsRef       = useRef([]);   // mirror of state — safe to use inside callbacks
  const syncIntervalRef   = useRef(null);
  const meetingStartRef   = useRef(null);
  const segmentIdRef      = useRef(0);

  // ── INTEGRATION POINT: LLM server socket ────────────────────────────────
  // Uncomment and fill in when the LLM transcription server is ready.
  //
  // import { io as llmIo } from 'socket.io-client';
  // const llmSocketRef = useRef(null);
  // ────────────────────────────────────────────────────────────────────────

  const buildFullText = (segs) =>
    segs.map((s) => s.text).filter(Boolean).join(' ');

  // Sync current segments to SFU server (lightweight — text only, no audio)
  const syncToSFU = useCallback(
    (segs) => {
      socket.emit('syncTranscript', {
        roomId,
        segments: segs,
        fullText: buildFullText(segs),
      });
    },
    [roomId]
  );

  // ── Start transcription (host only) ─────────────────────────────────────

  const startTranscription = useCallback(async () => {
    if (!localStream || role !== 'host') return;

    // Tell SFU server to create a transcript record for this room
    socket.emit('startTranscription', { roomId });
    meetingStartRef.current = Date.now();
    segmentsRef.current = [];
    segmentIdRef.current = 0;

    setIsRecording(true);
    setTranscriptStatus('live');
    setSegments([]);

    // ── INTEGRATION POINT A: connect to LLM transcription server ────────
    // Replace this block when the LLM server is ready.
    //
    // llmSocketRef.current = llmIo('http://YOUR_LLM_SERVER_HOST:PORT');
    //
    // llmSocketRef.current.emit('startSession', { sessionId: roomId });
    //
    // llmSocketRef.current.on('transcriptSegment', ({ text, startOffset, endOffset }) => {
    //   // Match the pending segment closest to this offset and fill in the text
    //   segmentsRef.current = segmentsRef.current.map((s) =>
    //     s.status === 'pending' && Math.abs(s.startOffset - startOffset) < 1.5
    //       ? { ...s, text, endOffset, status: 'complete' }
    //       : s
    //   );
    //   setSegments([...segmentsRef.current]);
    // });
    //
    // llmSocketRef.current.on('connect_error', (err) => {
    //   console.error('[LLM Server] Connection error:', err.message);
    // });
    // ────────────────────────────────────────────────────────────────────

    // Set up MediaRecorder on the host's audio track only
    const audioOnlyStream = new MediaStream(localStream.getAudioTracks());

    // audio/webm;codecs=opus — widely supported, low latency
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    const recorder = new MediaRecorder(audioOnlyStream, { mimeType });
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;

      const now = Date.now();
      const startOffset = parseFloat(
        ((now - meetingStartRef.current) / 1000).toFixed(2)
      );

      // ── INTEGRATION POINT B: send audio chunk to LLM server ─────────
      // Uncomment when LLM server is ready.
      //
      // llmSocketRef.current?.emit('audioChunk', {
      //   sessionId: roomId,
      //   chunk: event.data,     // Blob — audio/webm;codecs=opus
      //   startOffset,           // seconds from meeting start
      // });
      //
      // The LLM server should respond via 'transcriptSegment' event (see POINT A above).
      // ────────────────────────────────────────────────────────────────

      // Placeholder segment — text will be filled by LLM server response
      const newSeg = {
        id: ++segmentIdRef.current,
        text: '',           // populated when LLM server responds
        startOffset,
        endOffset: null,
        timestamp: now,
        status: 'pending',  // 'pending' → 'complete' after LLM responds
      };

      segmentsRef.current = [...segmentsRef.current, newSeg];
      setSegments([...segmentsRef.current]);
    };

    // Emit a chunk every CHUNK_INTERVAL_MS
    recorder.start(CHUNK_INTERVAL_MS);

    // Periodic sync of text segments to SFU server
    syncIntervalRef.current = setInterval(() => {
      syncToSFU(segmentsRef.current);
    }, SYNC_INTERVAL_MS);
  }, [localStream, role, roomId, syncToSFU]);

  // ── Stop transcription (host only) ──────────────────────────────────────

  const stopTranscription = useCallback(() => {
    mediaRecorderRef.current?.stop();
    clearInterval(syncIntervalRef.current);

    // Final sync before marking complete
    syncToSFU(segmentsRef.current);
    socket.emit('endTranscription', { roomId });

    setIsRecording(false);
    setTranscriptStatus('complete');

    // ── INTEGRATION POINT C: disconnect from LLM server ─────────────────
    // Uncomment when LLM server is ready.
    //
    // llmSocketRef.current?.emit('endSession', { sessionId: roomId });
    // llmSocketRef.current?.disconnect();
    // llmSocketRef.current = null;
    // ────────────────────────────────────────────────────────────────────
  }, [roomId, syncToSFU]);

  // ── Participant fetches transcript after meeting ──────────────────────────

  const fetchTranscript = useCallback(() => {
    socket.emit('getTranscript', { roomId }, (res) => {
      if (res.error) {
        console.warn('[Transcript] Fetch error:', res.error);
        return;
      }
      setSegments(res.segments || []);
      setTranscriptStatus(res.status);
    });
  }, [roomId]);

  return {
    segments,
    isRecording,
    transcriptStatus,
    startTranscription,
    stopTranscription,
    fetchTranscript,
  };
}
