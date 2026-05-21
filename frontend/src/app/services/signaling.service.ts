import { Injectable, signal, WritableSignal } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';

export interface User {
  socketId: string;
  username: string;
  isHost: boolean;
}

export interface ChatMessage {
  id: string;
  sender: string;
  senderId: string;
  text: string;
  timestamp: string;
}

@Injectable({
  providedIn: 'root'
})
export class SignalingService {
  private socket!: Socket;
  
  // App states
  public currentRoomId = signal<string>('');
  public currentUser = signal<User | null>(null);
  public users = signal<User[]>([]);
  public chatMessages: WritableSignal<ChatMessage[]> = signal([]);
  public activeReaction = signal<{ username: string; reaction: string } | null>(null);
  
  // Media states
  public localWebcamStream = signal<MediaStream | null>(null);
  public remoteWebcamStream = signal<MediaStream | null>(null);
  public isMuted = signal<boolean>(false);
  public isCameraOff = signal<boolean>(false);

  // Screen/Movie Stream (Main screen)
  public localScreenStream = signal<MediaStream | null>(null);
  public remoteScreenStream = signal<MediaStream | null>(null);
  public isScreenSharing = signal<boolean>(false);
  public remoteStreamType = signal<'none' | 'screen' | 'file'>('none');

  // Playback sync stater control states (sync)
  public playbackState = signal<{ playing: boolean; time: number; speed: number }>({
    playing: false,
    time: 0,
    speed: 1
  });

  // Peer connections
  private pcWebcam: RTCPeerConnection | null = null;
  private pcScreen: RTCPeerConnection | null = null;

  // Signaling URL
  private signalingUrl = environment.signalingServerUrl;

  constructor() {
    this.socket = io(this.signalingUrl, { autoConnect: false });
    this.setupSocketListeners();
  }

  // Connect & Join
  public joinRoom(roomId: string, username: string) {
    this.currentRoomId.set(roomId);
    if (!this.socket.connected) {
      this.socket.connect();
    }
    this.socket.emit('join-room', { roomId, username });
  }

  // Disconnect & Leave
  public leaveRoom() {
    this.socket.disconnect();
    this.closeWebcamPeer();
    this.closeScreenPeer();
    this.stopLocalWebcam();
    this.stopLocalScreen();
    this.users.set([]);
    this.chatMessages.set([]);
    this.remoteWebcamStream.set(null);
    this.remoteScreenStream.set(null);
    this.isScreenSharing.set(false);
  }

  private setupSocketListeners() {
    // 1. Room Users List
    this.socket.on('room-users', ({ users, userId }) => {
      this.users.set(users);
      const self = users.find((u: User) => u.socketId === userId);
      if (self) {
        this.currentUser.set(self);
      }
      
      // If we are guest, request initial state from host
      if (self && !self.isHost) {
        this.socket.emit('request-sync', { roomId: this.currentRoomId() });
      }

      // Automatically initiate webcam peer connection if there is another user
      const otherUser = users.find((u: User) => u.socketId !== userId);
      if (otherUser) {
        this.initiateWebcamCall(otherUser.socketId);
      }
    });

    // 2. User Joined
    this.socket.on('user-joined', (user: User) => {
      this.users.update(prev => [...prev, user]);
      // Host initiates connection to new guest
      if (this.currentUser()?.isHost) {
        this.initiateWebcamCall(user.socketId);
        // Late-joiner fix: If a screen share is active, also connect the screen share stream
        if (this.isScreenSharing()) {
          this.initiateScreenCall(user.socketId);
        }
      }
    });

    // 3. User Left
    this.socket.on('user-left', ({ socketId }) => {
      this.users.update(prev => prev.filter(u => u.socketId !== socketId));
      if (this.remoteWebcamStream() && this.pcWebcam) {
        this.closeWebcamPeer();
        this.remoteWebcamStream.set(null);
      }
      if (this.remoteScreenStream() && this.pcScreen) {
        this.closeScreenPeer();
        this.remoteScreenStream.set(null);
      }
    });

    // 4. Host Changed
    this.socket.on('host-changed', ({ newHostId }) => {
      this.users.update(prev => prev.map(u => ({
        ...u,
        isHost: u.socketId === newHostId
      })));
      if (this.currentUser()?.socketId === newHostId) {
        this.currentUser.update(prev => prev ? { ...prev, isHost: true } : null);
      }
    });

    // 5. Signaling Data Forwarder
    this.socket.on('webrtc-signal', async (payload) => {
      const { senderId, signalData } = payload;
      if (signalData.type === 'webcam-offer') {
        await this.handleWebcamOffer(senderId, signalData.sdp);
      } else if (signalData.type === 'webcam-answer') {
        await this.handleWebcamAnswer(signalData.sdp);
      } else if (signalData.type === 'webcam-candidate') {
        await this.handleWebcamCandidate(signalData.candidate);
      } else {
        switch (signalData.type) {
          case 'screen-offer':
            this.handleScreenOffer(payload.senderId, payload.signalData.sdp, payload.signalData.streamType);
            break;
          case 'screen-answer':
            this.handleScreenAnswer(payload.signalData.sdp);
            break;
          case 'screen-candidate':
            this.handleScreenCandidate(payload.signalData.candidate);
            break;
          case 'screen-ended':
            this.remoteScreenStream.set(null);
            this.remoteStreamType.set('none');
            this.closeScreenPeer();
            break;
        }
      }
    });

    // 6. Playback synchronization
    this.socket.on('playback-sync', ({ action, time, speed }) => {
      this.playbackState.set({ playing: action === 'play', time, speed });
    });

    // 7. Sync State Requests
    this.socket.on('request-current-state', ({ requesterId }) => {
      // Host sends current state to guest
      const videoElement = document.getElementById('watch-player') as HTMLVideoElement;
      this.socket.emit('send-current-state', {
        targetId: requesterId,
        time: videoElement ? videoElement.currentTime : 0,
        playing: videoElement ? !videoElement.paused : false,
        speed: videoElement ? videoElement.playbackRate : 1,
        videoUrl: '' // URL of local file cannot be transferred, but playback controls can
      });
    });

    this.socket.on('current-state', ({ time, playing, speed }) => {
      this.playbackState.set({ playing, time, speed });
    });

    // 8. Chat Message
    this.socket.on('chat-message', (msg: ChatMessage) => {
      this.chatMessages.update(prev => [...prev, msg]);
    });

    // 9. Reactions
    this.socket.on('reaction', ({ username, reaction }) => {
      this.activeReaction.set({ username, reaction });
      // Reset reaction after 3 seconds
      setTimeout(() => {
        this.activeReaction.set(null);
      }, 3000);
    });
  }

  // --- WEBCAM PEER CONNECTION ---
  public async startLocalWebcam() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 300, height: 300, facingMode: 'user' },
        audio: true
      });
      this.localWebcamStream.set(stream);
      return stream;
    } catch (err) {
      console.error('Error accessing camera/microphone:', err);
      // Fallback to audio only
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.localWebcamStream.set(stream);
        return stream;
      } catch (err2) {
        console.error('Error accessing microphone:', err2);
      }
      return null;
    }
  }

  public stopLocalWebcam() {
    const stream = this.localWebcamStream();
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      this.localWebcamStream.set(null);
    }
  }

  public toggleMute() {
    const stream = this.localWebcamStream();
    if (stream) {
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        this.isMuted.set(!audioTrack.enabled);
      }
    }
  }

  public toggleCamera() {
    const stream = this.localWebcamStream();
    if (stream) {
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        this.isCameraOff.set(!videoTrack.enabled);
      }
    }
  }

  private async initiateWebcamCall(targetId: string) {
    if (!this.localWebcamStream()) {
      await this.startLocalWebcam();
    }
    
    this.pcWebcam = this.createWebcamPeerConnection(targetId);
    
    const stream = this.localWebcamStream();
    if (stream) {
      stream.getTracks().forEach(track => {
        this.pcWebcam!.addTrack(track, stream);
      });
    }

    const offer = await this.pcWebcam.createOffer();
    await this.pcWebcam.setLocalDescription(offer);
    
    this.socket.emit('webrtc-signal', {
      targetId,
      signalData: { type: 'webcam-offer', sdp: offer }
    });
  }

  private createWebcamPeerConnection(targetId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc-signal', {
          targetId,
          signalData: { type: 'webcam-candidate', candidate: event.candidate }
        });
      }
    };

    pc.ontrack = (event) => {
      console.log('Received remote webcam track:', event.streams[0]);
      this.remoteWebcamStream.set(event.streams[0]);
    };

    return pc;
  }

  private async handleWebcamOffer(senderId: string, sdp: RTCSessionDescriptionInit) {
    if (!this.localWebcamStream()) {
      await this.startLocalWebcam();
    }
    
    this.pcWebcam = this.createWebcamPeerConnection(senderId);
    
    const stream = this.localWebcamStream();
    if (stream) {
      stream.getTracks().forEach(track => {
        this.pcWebcam!.addTrack(track, stream);
      });
    }

    await this.pcWebcam.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await this.pcWebcam.createAnswer();
    await this.pcWebcam.setLocalDescription(answer);

    this.socket.emit('webrtc-signal', {
      targetId: senderId,
      signalData: { type: 'webcam-answer', sdp: answer }
    });
  }

  private async handleWebcamAnswer(sdp: RTCSessionDescriptionInit) {
    if (this.pcWebcam) {
      await this.pcWebcam.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  }

  private async handleWebcamCandidate(candidate: RTCIceCandidateInit) {
    if (this.pcWebcam) {
      await this.pcWebcam.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  private closeWebcamPeer() {
    if (this.pcWebcam) {
      this.pcWebcam.close();
      this.pcWebcam = null;
    }
  }

  // --- SCREEN SHARE PEER CONNECTION (MOVIE STREAM) ---
  public async startScreenShare() {
    try {
      // Capture screen with audio
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      this.localScreenStream.set(stream);
      this.isScreenSharing.set(true);

      // Notify guest by initiating screen connection
      const guest = this.users().find(u => u.socketId !== this.currentUser()?.socketId);
      if (guest) {
        this.initiateScreenCall(guest.socketId);
      }

      // Listen for stream stop (when host clicks 'Stop Sharing' in browser popup)
      stream.getVideoTracks()[0].onended = () => {
        this.stopLocalScreen();
      };

      return stream;
    } catch (err) {
      console.error('Error starting screen share:', err);
      return null;
    }
  }

  public stopLocalScreen() {
    const stream = this.localScreenStream();
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      this.localScreenStream.set(null);
    }
    this.isScreenSharing.set(false);
    this.remoteStreamType.set('none');
    this.closeScreenPeer();
    
    // Notify peer by closing signaling
    const guest = this.users().find(u => u.socketId !== this.currentUser()?.socketId);
    if (guest) {
      this.socket.emit('webrtc-signal', {
        targetId: guest.socketId,
        signalData: { type: 'screen-ended' }
      });
    }
  }

  public async initiateScreenCall(targetId: string, streamType: 'screen' | 'file' = 'screen') {
    this.pcScreen = this.createScreenPeerConnection(targetId);
    
    const stream = this.localScreenStream();
    if (stream) {
      stream.getTracks().forEach(track => {
        this.pcScreen!.addTrack(track, stream);
      });
    }

    const offer = await this.pcScreen.createOffer();
    await this.pcScreen.setLocalDescription(offer);
    
    this.socket.emit('webrtc-signal', {
      targetId,
      signalData: { type: 'screen-offer', sdp: offer, streamType }
    });
  }

  private createScreenPeerConnection(targetId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc-signal', {
          targetId,
          signalData: { type: 'screen-candidate', candidate: event.candidate }
        });
      }
    };

    pc.ontrack = (event) => {
      console.log('Received remote screen/movie track:', event.streams[0]);
      this.remoteScreenStream.set(event.streams[0]);
    };

    return pc;
  }

  private async handleScreenOffer(senderId: string, sdp: RTCSessionDescriptionInit, streamType?: 'screen' | 'file') {
    if (streamType) {
      this.remoteStreamType.set(streamType);
    }
    this.pcScreen = this.createScreenPeerConnection(senderId);
    await this.pcScreen.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await this.pcScreen.createAnswer();
    await this.pcScreen.setLocalDescription(answer);

    this.socket.emit('webrtc-signal', {
      targetId: senderId,
      signalData: { type: 'screen-answer', sdp: answer }
    });
  }

  private async handleScreenAnswer(sdp: RTCSessionDescriptionInit) {
    if (this.pcScreen) {
      await this.pcScreen.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  }

  private async handleScreenCandidate(candidate: RTCIceCandidateInit) {
    if (this.pcScreen) {
      await this.pcScreen.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  private closeScreenPeer() {
    if (this.pcScreen) {
      this.pcScreen.close();
      this.pcScreen = null;
    }
  }

  // --- ACTIONS (SYNC, CHAT, REACTIONS) ---
  public sendPlaybackSync(action: 'play' | 'pause' | 'seek', time: number, speed: number = 1) {
    this.socket.emit('playback-sync', {
      roomId: this.currentRoomId(),
      action,
      time,
      speed
    });
  }

  public sendChatMessage(text: string) {
    if (text.trim()) {
      this.socket.emit('chat-message', {
        roomId: this.currentRoomId(),
        text
      });
    }
  }

  public sendReaction(reaction: string) {
    this.socket.emit('send-reaction', {
      roomId: this.currentRoomId(),
      reaction
    });
  }
}
