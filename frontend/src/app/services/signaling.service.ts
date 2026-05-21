import { Injectable, signal, WritableSignal } from '@angular/core';
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
  private peer: Peer | null = null;
  private dataConn: DataConnection | null = null;
  private guestId: string | null = null; // Used by host to track guest peer ID
  private restoreMicAfterShare = false;
  private readonly rtcConfig = {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        // Public relay for hobby/demo usage. Replace with your own TURN for production reliability.
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
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

  // Playback sync
  public playbackState = signal<{ playing: boolean; time: number; speed: number }>({
    playing: false,
    time: 0,
    speed: 1
  });

  constructor() {}

  // --- Connection Logic (Serverless) ---
  
  public joinRoom(roomId: string, username: string, isHost: boolean): Promise<void> {
    this.currentRoomId.set(roomId);
    
    return new Promise((resolve, reject) => {
      if (isHost) {
        // Host claims the specific room ID
        this.peer = new Peer(roomId, this.rtcConfig);
        this.peer.on('open', (id) => {
          this.currentUser.set({ id, username, isHost: true });
          this.users.set([{ id, username, isHost: true }]);
          resolve();
        });
        this.peer.on('error', (err) => {
          console.error('PeerJS Error:', err);
          reject(err);
        });

      // Host receives data connection from guest
      this.peer.on('connection', (conn) => {
        this.dataConn = conn;
        this.guestId = conn.peer;
        
        const guestName = (conn.metadata as any)?.username || 'Guest';
        this.users.update(u => [...u, { id: conn.peer, username: guestName, isHost: false }]);
        
        this.setupDataListeners(conn);
        
        // Send initial state to the guest once connected
        conn.on('open', () => {
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
          if (this.localScreenStream() && this.hostScreenStreamType() !== 'none') {
            this.initiateScreenCall(this.hostScreenStreamType() as 'screen' | 'file', this.hostScreenFileName());
          }
        });
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
      this.peer = new Peer(this.rtcConfig);
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
          reject(err);
        }
      };

      this.peer.on('open', (id) => {
        this.currentUser.set({ id, username, isHost: false });

        // Open data connection
        const conn = this.peer!.connect(roomId, { metadata: { username } });
        this.dataConn = conn;
        this.setupDataListeners(conn);
        
        // Once connected, call the host with our webcam
        conn.on('open', () => {
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
        });

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
          call.answer(); // Answer without stream to just receive
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

      this.peer.on('error', (err) => {
        console.error('PeerJS Error:', err);
        safeReject(err);
      });

      // If room host is unreachable/non-existent, fail fast so caller can handle fallback.
      setTimeout(() => {
        if (!settled && (!this.dataConn || !this.dataConn.open)) {
          safeReject(new Error('room-unavailable'));
        }
      }, 8000);
      } // Closes else block
    });
  }

  public leaveRoom() {
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    this.stopLocalWebcam();
    this.stopScreenShare();
    this.users.set([]);
    this.chatMessages.set([]);
    this.remoteWebcamStream.set(null);
    this.remoteScreenStream.set(null);
    this.isScreenSharing.set(false);
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
        }
      });
    });
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

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

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
    } catch (error) {
      console.error('Error accessing media devices.', error);
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
    this.peer.call(this.guestId, stream, { metadata: { type: 'screen', streamType } });
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
}
