const { createRouter } = require('./mediasoupWorker');
const config = require('./config');

/**
 * Room — represents a single video call session.
 *
 * Holds:
 *   - mediasoup Router (one per room)
 *   - peers: Map<socketId, Peer>
 *
 * Each Peer holds:
 *   - role: 'host' | 'participant'
 *   - transports: Map<transportId, Transport>
 *   - producers: Map<producerId, Producer>
 *   - consumers: Map<consumerId, Consumer>
 *
 * Designed to be extended: you can add transcript streams,
 * recording, or LLM hooks by subscribing to producer events here.
 */
class Room {
  constructor(roomId) {
    this.id = roomId;
    this.router = null;
    this.peers = new Map(); // socketId → Peer
  }

  async init() {
    this.router = await createRouter();
    return this;
  }

  // ─── Peer management ──────────────────────────────────────────────────────

  addPeer(socketId, role) {
    const peer = {
      id: socketId,
      role, // 'host' | 'participant'
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    };
    this.peers.set(socketId, peer);
    console.log(`[Room ${this.id}] Peer added: ${socketId} (${role})`);
    return peer;
  }

  getPeer(socketId) {
    return this.peers.get(socketId);
  }

  removePeer(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;

    // Clean up mediasoup resources
    for (const transport of peer.transports.values()) {
      transport.close();
    }
    this.peers.delete(socketId);
    console.log(`[Room ${this.id}] Peer removed: ${socketId}`);
  }

  getHost() {
    for (const peer of this.peers.values()) {
      if (peer.role === 'host') return peer;
    }
    return null;
  }

  // ─── Transport ────────────────────────────────────────────────────────────

  /**
   * Creates a WebRTC transport for a peer (send or receive).
   * Returns transport params needed by the client to connect.
   */
  async createWebRtcTransport(socketId) {
    const transport = await this.router.createWebRtcTransport({
      listenIps: config.webRtcTransport.listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: config.webRtcTransport.initialAvailableOutgoingBitrate,
    });

    // Log ICE state changes (useful for debugging)
    transport.on('icestatechange', (state) => {
      console.log(`[Transport ${transport.id}] ICE state → ${state}`);
    });
    transport.on('dtlsstatechange', (state) => {
      if (state === 'failed' || state === 'closed') {
        console.warn(`[Transport ${transport.id}] DTLS state → ${state}`);
      }
    });

    const peer = this.peers.get(socketId);
    if (peer) peer.transports.set(transport.id, transport);

    // Return only what the client needs to call device.createSendTransport / createRecvTransport
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  // ─── Connect transport (DTLS handshake) ──────────────────────────────────

  async connectTransport(socketId, transportId, dtlsParameters) {
    const peer = this.peers.get(socketId);
    if (!peer) throw new Error(`Peer not found: ${socketId}`);

    const transport = peer.transports.get(transportId);
    if (!transport) throw new Error(`Transport not found: ${transportId}`);

    await transport.connect({ dtlsParameters });
    console.log(`[Transport ${transportId}] DTLS connected`);
  }

  // ─── Produce (host sends media) ───────────────────────────────────────────

  async produce(socketId, transportId, kind, rtpParameters) {
    const peer = this.peers.get(socketId);
    if (!peer) throw new Error(`Peer not found: ${socketId}`);

    const transport = peer.transports.get(transportId);
    if (!transport) throw new Error(`Transport not found: ${transportId}`);

    const producer = await transport.produce({ kind, rtpParameters });

    peer.producers.set(producer.id, producer);

    producer.on('transportclose', () => {
      console.log(`[Producer ${producer.id}] Transport closed`);
      peer.producers.delete(producer.id);
    });

    console.log(`[Producer ${producer.id}] Created (kind: ${kind})`);
    return producer.id;
  }

  // ─── Consume (participant receives media) ─────────────────────────────────

  /**
   * Creates a Consumer on the server side for a participant.
   * The participant's device RTP capabilities are checked against the router
   * to ensure compatibility before consuming.
   */
  async consume(socketId, producerId, rtpCapabilities) {
    // Check router can route this producer to the consumer
    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error(`Cannot consume producer ${producerId} — RTP capabilities mismatch`);
    }

    const peer = this.peers.get(socketId);
    if (!peer) throw new Error(`Peer not found: ${socketId}`);

    // Find a recv transport for this peer (created before calling consume)
    const recvTransport = [...peer.transports.values()].find(
      (t) => t.appData?.direction === 'recv'
    );
    if (!recvTransport) throw new Error(`No recv transport found for peer ${socketId}`);

    const consumer = await recvTransport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // Start paused; client resumes after setting up <video>
    });

    peer.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
      console.log(`[Consumer ${consumer.id}] Transport closed`);
      peer.consumers.delete(consumer.id);
    });

    console.log(`[Consumer ${consumer.id}] Created for producer ${producerId}`);

    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Returns all producer IDs in the room (excluding the requesting peer) */
  getProducerList(excludeSocketId) {
    const producers = [];
    for (const [socketId, peer] of this.peers) {
      if (socketId === excludeSocketId) continue;
      for (const [producerId, producer] of peer.producers) {
        producers.push({ producerId, kind: producer.kind, peerId: socketId });
      }
    }
    return producers;
  }

  get rtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  isEmpty() {
    return this.peers.size === 0;
  }
}

module.exports = Room;
