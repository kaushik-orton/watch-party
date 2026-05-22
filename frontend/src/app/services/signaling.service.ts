import { Injectable, signal, WritableSignal, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Peer, MediaConnection, DataConnection } from 'peerjs';


export interface User {
  id: string; // Peer ID
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
  private router = inject(Router);
  private peer: Peer | null = null;
  private dataConn: DataConnection | null = null;
  private guestId: string | null = null; // Used by host to track guest peer ID
  private restoreMicAfterShare = false;
  private readonly rtcConfig = {
    config: {
      iceServers: [
        { urls: 'stun:stun.relay.metered.ca:80' },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        {
          urls: 'turn:asia.relay.metered.ca:80',
          username: 'd4f8ae01d391fe36bf24ccb2',
          credential: 'DQh6QIGb5O/gZhON',
        },
        {
          urls: 'turn:asia.relay.metered.ca:80?transport=tcp',
          username: 'd4f8ae01d391fe36bf24ccb2',
          credential: 'DQh6QIGb5O/gZhON',
        },
        {
          urls: 'turn:asia.relay.metered.ca:443',
          username: 'd4f8ae01d391fe36bf24ccb2',
          credential: 'DQh6QIGb5O/gZhON',
        },
        {
          urls: 'turns:asia.relay.metered.ca:443?transport=tcp',
          username: 'd4f8ae01d391fe36bf24ccb2',
          credential: 'DQh6QIGb5O/gZhON',
        },
      ]
    }
  };
  
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

  // Screen/Movie Stream
  public localScreenStream = signal<MediaStream | null>(null);
  public remoteScreenStream = signal<MediaStream | null>(null);
  public isScreenSharing = signal<boolean>(false);
  public remoteStreamType = signal<'none' | 'screen' | 'file'>('none');
  public hostScreenStreamType = signal<'none' | 'screen' | 'file'>('none'); // What the host is currently sharing
  public hostScreenFileName = signal<string>('');
  public remoteVideoFileName = signal<string>('');
  public hasLocalFileLoaded = signal<boolean>(false);

  private screenCall: MediaConnection | null = null;

  // Playback sync
  public playbackState = signal<{ playing: boolean; time: number; speed: number }>({
    playing: false,
    time: 0,
    speed: 1
  });

  constructor() {
    // Synchronously leave room on page reload or close to prevent stale session IDs
    window.addEventListener('beforeunload', () => {
      this.leaveRoom();
    });
  }

  // --- Connection Logic (Serverless) ---
  
  public joinRoom(roomId: string, username: string, isHost: boolean): Promise<void> {
    this.leaveRoom(); // Clean up any active/stale connections or states first!
    this.currentRoomId.set(roomId);
    
    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const safeReject = (err: unknown) => {
        if (!settled) {
          settled = true;
          this.leaveRoom(); // Ensure we destroy the failed peer instance
          reject(err);
        }
      };

      if (isHost) {
        // Host claims the specific room ID
        this.peer = new Peer(roomId, this.rtcConfig);
        this.peer.on('open', (id) => {
          this.currentUser.set({ id, username, isHost: true });
          this.users.set([{ id, username, isHost: true }]);
          safeResolve();
        });
        this.peer.on('disconnected', () => {
          console.warn('Host peer disconnected from signaling server. Reconnecting...');
          this.peer?.reconnect();
        });
        this.peer.on('error', (err) => {
          console.error('PeerJS Error:', err);
          safeReject(err);
        });

        // Host receives data connection from guest
        this.peer.on('connection', (conn) => {
          this.dataConn = conn;
          this.guestId = conn.peer;
          
          const guestName = (conn.metadata as any)?.username || 'Guest';
          this.users.update(u => [...u, { id: conn.peer, username: guestName, isHost: false }]);
          
          this.setupDataListeners(conn);
          this.monitorConnection(conn, 'Host');
          
          // Send initial state to the guest once connected
          const onOpen = () => {
            this.broadcast('users', { users: this.users() });
            this.broadcast('sync', { state: this.playbackState() });
            
            // Call guest if our camera is already ready
            if (this.localWebcamStream()) {
              const call = this.peer!.call(this.guestId!, this.localWebcamStream()!, { metadata: { type: 'webcam' } });
              call.on('stream', (remoteStream) => {
                setTimeout(() => {
                  this.remoteWebcamStream.set(remoteStream);
                });
              });
            }
            
            // If host is already sharing a screen/file, send it to the late-joining guest
            if (this.hostScreenStreamType() !== 'none') {
              if (this.localScreenStream()) {
                this.initiateScreenCall(this.hostScreenStreamType() as 'screen' | 'file', this.hostScreenFileName());
              } else {
                this.broadcastStreamFileNameOnly(this.hostScreenFileName());
              }
            }
          };

          if (conn.open) {
            onOpen();
          } else {
            conn.on('open', onOpen);
          }
        });

        // Host receives webcam call from guest
        this.peer.on('call', (call) => {
          if ((call.metadata as any)?.type === 'webcam') {
            // Answer with our webcam (even if null)
            call.answer(this.localWebcamStream() || undefined);
            call.on('stream', (remoteStream) => {
              setTimeout(() => {
                this.remoteWebcamStream.set(remoteStream);
              });
            });
          }
        });
        
      } else {
        // Guest creates a random peer and connects to the host
        this.peer = new Peer(undefined as any, this.rtcConfig);

        this.peer.on('open', (id) => {
          this.currentUser.set({ id, username, isHost: false });

          // Open data connection
          const conn = this.peer!.connect(roomId, { metadata: { username } });
          this.dataConn = conn;
          this.setupDataListeners(conn);
          this.monitorConnection(conn, 'Guest');
          
          // Once connected, call the host with our webcam
          const onOpen = () => {
            setTimeout(() => {
              safeResolve();

              if (this.localWebcamStream()) {
                const call = this.peer!.call(roomId, this.localWebcamStream()!, { metadata: { type: 'webcam' } });
                call.on('stream', (remoteStream) => {
                  setTimeout(() => {
                    this.remoteWebcamStream.set(remoteStream);
                  });
                });
              }
            });
          };

          if (conn.open) {
            onOpen();
          } else {
            conn.on('open', onOpen);
          }

          conn.on('error', (err) => {
            console.error('Guest data connection error:', err);
            safeReject(err);
          });
        });
        
        // Guest receives calls from host
        this.peer.on('call', (call) => {
          if ((call.metadata as any)?.type === 'webcam') {
            // Answer with our webcam (even if null)
            call.answer(this.localWebcamStream() || undefined);
            call.on('stream', (remoteStream) => {
              setTimeout(() => {
                this.remoteWebcamStream.set(remoteStream);
              });
            });
          }
          else if ((call.metadata as any)?.type === 'screen') {
            if (this.hasLocalFileLoaded()) {
              console.log('Guest has local file loaded. Ignoring incoming screen stream call to save bandwidth.');
              return;
            }
            call.answer(); // Answer without stream to just receive
            this.screenCall = call; // Also save reference on guest
            setTimeout(() => {
              const streamType = (call.metadata as any)?.streamType || 'screen';
              this.remoteStreamType.set(streamType);
            });
            call.on('stream', (remoteStream) => {
              setTimeout(() => {
                this.remoteScreenStream.set(remoteStream);
              });
            });
          }
        });

        this.peer.on('disconnected', () => {
          console.warn('Guest peer disconnected from signaling server. Reconnecting...');
          this.peer?.reconnect();
        });

        this.peer.on('error', (err) => {
          console.error('PeerJS Error:', err);
          safeReject(err);
        });

        // If room host is unreachable/non-existent, fail fast so caller can handle fallback.
        setTimeout(() => {
          if (!settled && (!this.dataConn || !this.dataConn.open)) {
            const pc = (this.dataConn as any)?.peerConnection as RTCPeerConnection | undefined;
            const iceState = pc?.iceConnectionState || 'unknown';
            const gatherState = pc?.iceGatheringState || 'unknown';
            const connState = pc?.connectionState || 'unknown';
            console.error(`[WP] Connection timeout (15s). ICE: ${iceState}, Gathering: ${gatherState}, PC: ${connState}, conn.open: ${this.dataConn?.open}`);
            
            if (iceState === 'failed' || iceState === 'disconnected' || iceState === 'checking' || iceState === 'new') {
              safeReject({ type: 'network-error', message: `ICE connectivity failed (state: ${iceState}). A TURN relay server is required for cross-network connections.` });
            } else {
              safeReject(new Error('room-unavailable'));
            }
          }
        }, 15000);
      }
    });
  }

  public leaveRoom() {
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    this.stopLocalWebcam();
    this.stopScreenShare();
    this.stopScreenCallOnly();
    
    // Reset all signals and variables to prevent stale state in new rooms
    this.currentRoomId.set('');
    this.currentUser.set(null);
    this.users.set([]);
    this.chatMessages.set([]);
    this.remoteWebcamStream.set(null);
    this.remoteScreenStream.set(null);
    this.isScreenSharing.set(false);
    this.remoteStreamType.set('none');
    this.hostScreenStreamType.set('none');
    this.hostScreenFileName.set('');
    this.remoteVideoFileName.set('');
    this.hasLocalFileLoaded.set(false);
    this.playbackState.set({ playing: false, time: 0, speed: 1 });
    this.dataConn = null;
    this.guestId = null;
  }

  // --- Connection Monitoring ---
  private monitorConnection(conn: DataConnection, label: string) {
    console.log(`[WP][${label}] DataConnection created → peer=${conn.peer}, open=${conn.open}`);
    
    const attachPcMonitoring = () => {
      const pc = (conn as any)?.peerConnection as RTCPeerConnection | undefined;
      if (pc) {
        console.log(`[WP][${label}] RTCPeerConnection – ICE: ${pc.iceConnectionState}, Gathering: ${pc.iceGatheringState}`);
        
        pc.addEventListener('iceconnectionstatechange', () => {
          console.log(`[WP][${label}] ICE state → ${pc.iceConnectionState}`);
        });
        pc.addEventListener('icegatheringstatechange', () => {
          console.log(`[WP][${label}] ICE gathering → ${pc.iceGatheringState}`);
        });
        pc.addEventListener('icecandidate', (e) => {
          if (e.candidate) {
            console.log(`[WP][${label}] ICE candidate: type=${e.candidate.type} protocol=${e.candidate.protocol} ${e.candidate.candidate.substring(0, 90)}`);
          } else {
            console.log(`[WP][${label}] ICE candidate gathering complete`);
          }
        });
        pc.addEventListener('connectionstatechange', () => {
          console.log(`[WP][${label}] PeerConnection state → ${pc.connectionState}`);
        });
      } else {
        setTimeout(attachPcMonitoring, 300);
      }
    };
    attachPcMonitoring();
  }

  // --- Data Channel Events ---
  private setupDataListeners(conn: DataConnection) {
    conn.on('data', (raw: unknown) => {
      setTimeout(() => {
        const data = raw as any;
        switch (data.type) {
          case 'chat':
            this.chatMessages.update(msgs => [...msgs, data.message]);
            break;
          case 'reaction':
            this.activeReaction.set(data.reactionData);
            break;
          case 'sync':
            this.playbackState.set(data.state);
            break;
          case 'users':
            this.users.set(data.users);
            break;
          case 'screen-start':
            this.remoteStreamType.set(data.streamType);
            if (data.fileName) {
              this.remoteVideoFileName.set(data.fileName);
            }
            break;
          case 'screen-stop':
            this.remoteScreenStream.set(null);
            this.remoteStreamType.set('none');
            this.remoteVideoFileName.set('');
            break;
          case 'local-file-loaded':
            console.log('Guest loaded file locally. Stopping screen call to save bandwidth.');
            this.stopScreenCallOnly();
            break;
          case 'local-file-unloaded':
            console.log('Guest unloaded local file. Restarting screen call.');
            if (this.localScreenStream() && this.hostScreenStreamType() !== 'none') {
              this.initiateScreenCall(this.hostScreenStreamType() as 'screen' | 'file', this.hostScreenFileName());
            }
            break;
        }
      });
    });

    conn.on('close', () => {
      this.handleConnectionClose(conn);
    });

    conn.on('error', (err) => {
      console.error('Data connection error:', err);
      this.handleConnectionClose(conn);
    });
  }

  private handleConnectionClose(conn: DataConnection) {
    if (this.dataConn === conn) {
      console.log('Active peer connection closed or lost.');
      if (this.currentUser()?.isHost) {
        // Guest disconnected
        setTimeout(() => {
          this.dataConn = null;
          this.guestId = null;
          this.remoteWebcamStream.set(null);
          this.remoteScreenStream.set(null);
          
          // Re-set user list to just the host
          const host = this.currentUser();
          if (host) {
            this.users.set([host]);
          }
        });
      } else {
        // Host disconnected
        setTimeout(() => {
          alert('The host has disconnected. You will be redirected back to the lobby.');
          this.leaveRoom();
          this.router.navigate(['/']);
        });
      }
    }
  }

  private broadcast(type: string, payload: any) {
    if (this.dataConn && this.dataConn.open) {
      this.dataConn.send({ type, ...payload });
    }
  }

  // --- Media Flow Logic ---

  public async startLocalWebcam() {
    if (!navigator.mediaDevices?.getUserMedia) {
      console.error('getUserMedia is not supported in this browser/context.');
      return null;
    }

    // Stop any stale stream before requesting a fresh one
    this.stopLocalWebcam();

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 320, max: 480 },
          height: { ideal: 240, max: 360 },
          frameRate: { ideal: 15, max: 20 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (error: any) {
      console.warn('Failed to access both video and audio. Error name:', error.name);
      
      // If permission was explicitly denied, do not retry with fallback
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        console.error('Webcam/microphone permission denied.');
      } else {
        // Try fallback: video-only
        try {
          console.log('Attempting video-only fallback...');
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 320, max: 480 },
              height: { ideal: 240, max: 360 },
              frameRate: { ideal: 15, max: 20 }
            },
            audio: false
          });
        } catch (videoError: any) {
          console.warn('Failed video-only fallback:', videoError.name);
          if (videoError.name !== 'NotAllowedError' && videoError.name !== 'PermissionDeniedError') {
            // Try fallback: audio-only
            try {
              console.log('Attempting audio-only fallback...');
              stream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: {
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true
                }
              });
            } catch (audioError) {
              console.error('All media device access options failed:', audioError);
            }
          }
        }
      }
    }

    if (stream) {
      setTimeout(() => {
        this.localWebcamStream.set(stream);
      });
      
      // If we have a connected peer, initiate a webcam call to send our video!
      const targetId = this.currentUser()?.isHost ? this.guestId : this.currentRoomId();
      if (this.peer && this.dataConn?.open && targetId) {
        const call = this.peer.call(targetId, stream, { metadata: { type: 'webcam' } });
        call.on('stream', (remoteStream) => {
          setTimeout(() => {
            this.remoteWebcamStream.set(remoteStream);
          });
        });
      }
      return stream;
    }
    
    return null;
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
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        audioTracks[0].enabled = !audioTracks[0].enabled;
        this.isMuted.set(!audioTracks[0].enabled);
      }
    }
  }

  public toggleCamera() {
    const stream = this.localWebcamStream();
    if (stream) {
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length > 0) {
        videoTracks[0].enabled = !videoTracks[0].enabled;
        this.isCameraOff.set(!videoTracks[0].enabled);
      }
    }
  }

  // --- Screen/File Sharing (Host Only) ---

  private initiateScreenCall(streamType: 'screen' | 'file', fileName?: string) {
    const stream = this.localScreenStream();
    if (!stream || !this.guestId || !this.peer) return;

    this.broadcast('screen-start', { streamType, fileName });
    this.stopScreenCallOnly();
    this.screenCall = this.peer.call(this.guestId, stream, { metadata: { type: 'screen', streamType } });
  }

  public async startScreenShare() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 24, max: 30 },
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 }
        },
        audio: true
      });

      // Hint browser encoder for motion-heavy content (videos, scrolling, screen motion)
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.contentHint = 'motion';
        try {
          await videoTrack.applyConstraints({
            frameRate: { ideal: 24, max: 30 },
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 }
          });
        } catch (constraintError) {
          console.warn('Could not apply additional screen-share constraints:', constraintError);
        }
      }

      setTimeout(() => {
        this.localScreenStream.set(stream);
        this.isScreenSharing.set(true);
        this.hostScreenStreamType.set('screen');

        // Prevent doubled/echoed audio: mute mic while sharing system audio.
        const webcam = this.localWebcamStream();
        const micTrack = webcam?.getAudioTracks()[0];
        if (micTrack && micTrack.enabled) {
          micTrack.enabled = false;
          this.isMuted.set(true);
          this.restoreMicAfterShare = true;
        } else {
          this.restoreMicAfterShare = false;
        }
      });
      
      stream.getVideoTracks()[0].onended = () => {
        this.stopScreenShare();
      };

      this.initiateScreenCall('screen');
      return stream;
    } catch (err) {
      console.error('Error sharing screen:', err);
      return null;
    }
  }

  public setLocalFileStream(stream: MediaStream, fileName?: string) {
    // Stop any existing stream tracks first to free up system resources
    const oldStream = this.localScreenStream();
    if (oldStream) {
      oldStream.getTracks().forEach(track => track.stop());
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.contentHint = 'motion';
      videoTrack.applyConstraints({
        frameRate: { ideal: 24, max: 30 },
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 }
      }).catch((constraintError) => {
        console.warn('Could not apply file-stream constraints:', constraintError);
      });
    }

    this.localScreenStream.set(stream);
    this.isScreenSharing.set(true);
    this.hostScreenStreamType.set('file');

    // Prevent doubled/echoed audio for local file share too.
    const webcam = this.localWebcamStream();
    const micTrack = webcam?.getAudioTracks()[0];
    if (micTrack && micTrack.enabled) {
      micTrack.enabled = false;
      this.isMuted.set(true);
      this.restoreMicAfterShare = true;
    } else {
      this.restoreMicAfterShare = false;
    }

    if (fileName) {
      this.hostScreenFileName.set(fileName);
    }
    this.initiateScreenCall('file', fileName);
  }

  public stopScreenShare() {
    const stream = this.localScreenStream();
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      this.localScreenStream.set(null);
      this.isScreenSharing.set(false);
      this.hostScreenStreamType.set('none');
      this.hostScreenFileName.set('');
      this.broadcast('screen-stop', {});

      // Restore mic only if we muted it automatically at share start.
      if (this.restoreMicAfterShare) {
        const webcam = this.localWebcamStream();
        const micTrack = webcam?.getAudioTracks()[0];
        if (micTrack) {
          micTrack.enabled = true;
          this.isMuted.set(false);
        }
        this.restoreMicAfterShare = false;
      }
    }
  }

  // --- Application Actions ---
  
  public sendChatMessage(text: string) {
    const user = this.currentUser();
    if (!user) return;
    
    const message: ChatMessage = {
      id: Math.random().toString(36).substr(2, 9),
      sender: user.username,
      senderId: user.id,
      text,
      timestamp: new Date().toISOString()
    };
    
    this.chatMessages.update(msgs => [...msgs, message]);
    this.broadcast('chat', { message });
  }

  public sendReaction(reaction: string) {
    const user = this.currentUser();
    if (!user) return;
    
    const reactionData = { username: user.username, reaction };
    this.activeReaction.set(reactionData);
    this.broadcast('reaction', { reactionData });
    
    setTimeout(() => {
      this.activeReaction.set(null);
    }, 2000);
  }

  public updatePlaybackState(playing: boolean, time: number, speed: number) {
    const state = { playing, time, speed };
    this.playbackState.set(state);
    this.broadcast('sync', { state });
  }

  public setLocalFileNoStream(fileName: string) {
    this.stopScreenShare();
    this.hostScreenStreamType.set('file');
    this.hostScreenFileName.set(fileName);
    this.broadcast('screen-start', { streamType: 'file', fileName });
  }

  public broadcastStreamFileNameOnly(fileName: string) {
    this.hostScreenStreamType.set('file');
    this.hostScreenFileName.set(fileName);
    this.broadcast('screen-start', { streamType: 'file', fileName });
  }

  public notifyLocalFileStatus(loaded: boolean) {
    this.broadcast(loaded ? 'local-file-loaded' : 'local-file-unloaded', {});
  }

  public stopScreenCallOnly() {
    if (this.screenCall) {
      try {
        this.screenCall.close();
      } catch (e) {
        console.warn('Error closing screen call:', e);
      }
      this.screenCall = null;
    }
  }
}
