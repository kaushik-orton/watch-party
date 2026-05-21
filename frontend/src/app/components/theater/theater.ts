import { Component, inject, signal, ViewChild, ElementRef, AfterViewInit, OnDestroy, effect } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SignalingService, ChatMessage } from '../../services/signaling.service';

@Component({
  selector: 'app-theater',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './theater.html',
  styleUrl: './theater.css'
})
export class TheaterComponent implements AfterViewInit, OnDestroy {
  public signalingService = inject(SignalingService);
  private router = inject(Router);

  @ViewChild('localVideo') localVideoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('remoteVideo') remoteVideoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('remoteWebcamVideo') remoteWebcamVideoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('screenVideo') screenVideoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('localScreenVideo') localScreenVideoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('chatMessagesContainer') chatContainerRef!: ElementRef<HTMLDivElement>;

  // UI state signals
  public isChatOpen = signal(false);
  public chatMessageText = signal('');
  public selectedVideoFileName = signal('');
  public hasLocalFileLoaded = signal(false);
  public showShareMenu = signal(false);
  public isReactionsOpen = signal(true);
  public webcamError = signal<string>('');
  public isRemoteInPiP = signal(false);
  public isRecording = signal<'local' | 'remote' | null>(null);
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  public isControlsMinimized = signal(false);


  // Floating bubbles draggable positions
  public localBubblePos = signal({ x: 20, y: 20 });
  public remoteBubblePos = signal({ x: 20, y: 200 });
  private activeDragging: 'local' | 'remote' | null = null;
  private dragOffset = { x: 0, y: 0 };

  // Floating emojis for reactions
  public reactionsList = signal<{ id: string; emoji: string; left: number }[]>([]);

  constructor() {
    // Sync local custom player states when we get playback-sync events from socket
    effect(() => {
      const syncState = this.signalingService.playbackState();
      const videoElement = document.getElementById('watch-player') as HTMLVideoElement;
      if (videoElement && this.hasLocalFileLoaded()) {
        const timeDiff = Math.abs(videoElement.currentTime - syncState.time);
        
        // Only seek if difference is more than 1.5 seconds to avoid feedback loops
        if (syncState.time !== -1 && timeDiff > 1.5) {
          videoElement.currentTime = syncState.time;
        }

        if (syncState.playing && videoElement.paused) {
          videoElement.play().catch(() => {});
        } else if (!syncState.playing && !videoElement.paused) {
          videoElement.pause();
        }

        if (videoElement.playbackRate !== syncState.speed) {
          videoElement.playbackRate = syncState.speed;
        }
      }
    });

    // Listen to reaction events and show them floating on screen
    effect(() => {
      const reactionData = this.signalingService.activeReaction();
      if (reactionData) {
        this.triggerFloatingEmoji(reactionData.reaction);
      }
    });
  }

  ngAfterViewInit() {
    // Safety fallback: re-assign srcObject via ViewChild after a delay
    // (Primary assignment is done via [srcObject] template binding)
    effect(() => {
      const localStream = this.signalingService.localWebcamStream();
      if (localStream) {
        setTimeout(() => {
          if (this.localVideoRef?.nativeElement) {
            this.localVideoRef.nativeElement.srcObject = localStream;
            this.localVideoRef.nativeElement.play().catch(() => {});
          }
        }, 200);
      }
    });

    effect(() => {
      const remoteStream = this.signalingService.remoteWebcamStream();
      if (remoteStream) {
        setTimeout(() => {
          if (this.remoteWebcamVideoRef?.nativeElement) {
            this.remoteWebcamVideoRef.nativeElement.srcObject = remoteStream;
            this.remoteWebcamVideoRef.nativeElement.play().catch(() => {});
          }
        }, 200);
      }
    });

    effect(() => {
      const localScreen = this.signalingService.localScreenStream();
      if (localScreen) {
        setTimeout(() => {
          if (this.localScreenVideoRef?.nativeElement) {
            this.localScreenVideoRef.nativeElement.srcObject = localScreen;
            this.localScreenVideoRef.nativeElement.play().catch(() => {});
          }
        }, 200);
      }
    });

    // Auto-scroll chat to bottom when messages update
    effect(() => {
      const messages = this.signalingService.chatMessages();
      if (messages.length > 0) {
        setTimeout(() => this.scrollToBottom(), 50);
      }
    });

    // Automatically start webcam when joining room
    this.signalingService.startLocalWebcam().then(stream => {
      if (!stream) {
        this.webcamError.set('Camera/Microphone permission denied or unavailable.');
      } else {
        this.webcamError.set('');
      }
    });
  }

  ngOnDestroy() {
    this.signalingService.leaveRoom();
  }

  // --- LOCAL VIDEO FILE DROP HANDLING ---
  public onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.loadLocalVideo(input.files[0]);
    }
  }

  public onFileDropped(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer?.files && event.dataTransfer.files[0]) {
      this.loadLocalVideo(event.dataTransfer.files[0]);
    }
  }

  public onDragOver(event: DragEvent) {
    event.preventDefault();
  }

  private loadLocalVideo(file: File) {
    this.selectedVideoFileName.set(file.name);
    this.hasLocalFileLoaded.set(true);
    this.showShareMenu.set(false);

    // Load file into video element
    const fileUrl = URL.createObjectURL(file);
    setTimeout(() => {
      const videoElement = document.getElementById('watch-player') as HTMLVideoElement;
      if (videoElement) {
        videoElement.src = fileUrl;
        
        // Wait for metadata to load and capture the stream
        videoElement.onloadedmetadata = () => {
          // Capture stream (video + audio) from the video element
          let stream: MediaStream;
          const anyVideoEl = videoElement as any;
          if (anyVideoEl.captureStream) {
            stream = anyVideoEl.captureStream();
          } else if (anyVideoEl.mozCaptureStream) {
            stream = anyVideoEl.mozCaptureStream();
          } else {
            console.error('Browser does not support captureStream()');
            return;
          }

          // Share this stream via the screen peer connection
          this.signalingService.localScreenStream.set(stream);
          this.signalingService.isScreenSharing.set(true);
          // Connect to the guest
          const guest = this.signalingService.users().find(u => u.socketId !== this.signalingService.currentUser()?.socketId);
          if (guest) {
            // Trigger remote connection
            this.signalingService.initiateScreenCall(guest.socketId, 'file');
          }
        };
      }
    }, 100);
  }

  // --- PLAYBACK CONTROL HANDLERS (FOR CUSTOM PLAYER) ---
  public handlePlay() {
    const videoElement = document.getElementById('watch-player') as HTMLVideoElement;
    if (videoElement) {
      this.signalingService.sendPlaybackSync('play', videoElement.currentTime, videoElement.playbackRate);
    }
  }

  public handlePause() {
    const videoElement = document.getElementById('watch-player') as HTMLVideoElement;
    if (videoElement) {
      this.signalingService.sendPlaybackSync('pause', videoElement.currentTime, videoElement.playbackRate);
    }
  }

  public handleSeek() {
    const videoElement = document.getElementById('watch-player') as HTMLVideoElement;
    if (videoElement) {
      this.signalingService.sendPlaybackSync('seek', videoElement.currentTime, videoElement.playbackRate);
    }
  }

  public guestTogglePlay() {
    const isPlaying = this.signalingService.playbackState().playing;
    const action = isPlaying ? 'pause' : 'play';
    // Send time as -1 to indicate NO SEEKING, just state change.
    this.signalingService.sendPlaybackSync(action, -1);
  }

  // --- SCREEN SHARE CONTROL ---
  public startScreenSharing() {
    this.signalingService.startScreenShare();
    this.showShareMenu.set(false);
  }

  public stopScreenSharing() {
    this.signalingService.stopLocalScreen();
    this.hasLocalFileLoaded.set(false);
    this.selectedVideoFileName.set('');
  }

  // --- CHAT MANAGEMENT ---
  public sendChatMessage() {
    const text = this.chatMessageText().trim();
    if (text) {
      this.signalingService.sendChatMessage(text);
      this.chatMessageText.set('');
    }
  }

  private scrollToBottom() {
    if (this.chatContainerRef?.nativeElement) {
      this.chatContainerRef.nativeElement.scrollTop = this.chatContainerRef.nativeElement.scrollHeight;
    }
  }

  // --- REACTIONS ---
  public sendReaction(emoji: string) {
    this.signalingService.sendReaction(emoji);
  }

  private triggerFloatingEmoji(emoji: string) {
    const id = Math.random().toString(36).substring(2, 9);
    const left = Math.floor(Math.random() * 80) + 10; // Random horizontal placement (10% to 90%)
    
    this.reactionsList.update(prev => [...prev, { id, emoji, left }]);

    // Remove emoji from list after animation ends (3s)
    setTimeout(() => {
      this.reactionsList.update(prev => prev.filter(r => r.id !== id));
    }, 3000);
  }

  // --- VIDEO ELEMENT HELPERS ---
  public onVideoLoaded(event: Event) {
    const video = event.target as HTMLVideoElement;
    if (video) {
      video.play().catch(() => {});
    }
  }

  public getPartnerName(): string {
    const partner = this.signalingService.users().find(u => u.socketId !== this.signalingService.currentUser()?.socketId);
    return partner ? partner.username : 'Partner';
  }

  public isLocalVideoTrackActive(): boolean {
    const stream = this.signalingService.localWebcamStream();
    if (!stream) return false;
    const videoTrack = stream.getVideoTracks()[0];
    return !!(videoTrack && videoTrack.enabled);
  }

  public isRemoteVideoTrackActive(): boolean {
    const stream = this.signalingService.remoteWebcamStream();
    if (!stream) return false;
    const videoTrack = stream.getVideoTracks()[0];
    return !!(videoTrack && videoTrack.enabled);
  }

  // --- WEBCAM MIC / VIDEO CONTROLS ---
  public toggleMute() {
    this.signalingService.toggleMute();
  }

  public retryWebcam() {
    this.webcamError.set('');
    this.signalingService.startLocalWebcam().then(stream => {
      if (!stream) {
        this.webcamError.set('Camera/Microphone permission denied or unavailable.');
      } else {
        this.webcamError.set('');
      }
    });
  }

  public toggleCamera() {
    this.signalingService.toggleCamera();
  }

  public toggleRemotePiP() {
    if (this.remoteWebcamVideoRef?.nativeElement) {
      const video = this.remoteWebcamVideoRef.nativeElement;
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(err => console.error('Error exiting PiP:', err));
      } else {
        video.requestPictureInPicture()
          .then(() => {
            this.isRemoteInPiP.set(true);
            video.addEventListener('leavepictureinpicture', () => {
              this.isRemoteInPiP.set(false);
            }, { once: true });
          })
          .catch(err => console.error('Error entering PiP:', err));
      }
    }
  }

  // --- SCREENSHOT & RECORDING ---
  public takeScreenshot(target: 'local' | 'remote') {
    const video = target === 'local'
      ? this.localVideoRef?.nativeElement
      : this.remoteWebcamVideoRef?.nativeElement;

    if (!video || video.videoWidth === 0) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `watchparty-${target}-${timestamp}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  public toggleRecording(target: 'local' | 'remote') {
    // If already recording this target, stop it
    if (this.isRecording() === target) {
      this.stopRecording();
      return;
    }

    // If recording the other target, stop that first
    if (this.isRecording()) {
      this.stopRecording();
    }

    const stream = target === 'local'
      ? this.signalingService.localWebcamStream()
      : this.signalingService.remoteWebcamStream();

    if (!stream) return;

    this.recordedChunks = [];
    this.isRecording.set(target);

    try {
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9,opus'
      });
    } catch {
      // Fallback mime type
      this.mediaRecorder = new MediaRecorder(stream);
    }

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `watchparty-${target}-clip-${timestamp}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      this.recordedChunks = [];
    };

    this.mediaRecorder.start(1000); // collect data every 1 second

    // Auto-stop after 30 seconds
    setTimeout(() => {
      if (this.isRecording() === target) {
        this.stopRecording();
      }
    }, 30000);
  }

  private stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;
    this.isRecording.set(null);
  }

  public copyRoomLink() {
    const roomUrl = `${window.location.origin}?room=${this.signalingService.currentRoomId()}`;
    navigator.clipboard.writeText(roomUrl).then(() => {
      alert('Room invitation link copied to clipboard! Send it to Srinija.');
    });
  }

  public exitRoom() {
    this.router.navigate(['/']);
  }

  // --- DRAG CONTROLS FOR BUBBLES ---
  public onDragStart(event: MouseEvent | TouchEvent, bubble: 'local' | 'remote') {
    event.preventDefault();
    this.activeDragging = bubble;
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const currentPos = bubble === 'local' ? this.localBubblePos() : this.remoteBubblePos();
    this.dragOffset = {
      x: clientX - currentPos.x,
      y: clientY - currentPos.y
    };

    // Attach document level mousemove/mouseup listeners
    document.addEventListener('mousemove', this.onDragging);
    document.addEventListener('touchmove', this.onDragging, { passive: false });
    document.addEventListener('mouseup', this.onDragEnd);
    document.addEventListener('touchend', this.onDragEnd);
  }

  private onDragging = (event: MouseEvent | TouchEvent) => {
    if (!this.activeDragging) return;
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;

    const newX = clientX - this.dragOffset.x;
    const newY = clientY - this.dragOffset.y;

    if (this.activeDragging === 'local') {
      this.localBubblePos.set({ x: newX, y: newY });
    } else {
      this.remoteBubblePos.set({ x: newX, y: newY });
    }
  };

  private onDragEnd = () => {
    this.activeDragging = null;
    document.removeEventListener('mousemove', this.onDragging);
    document.removeEventListener('touchmove', this.onDragging);
    document.removeEventListener('mouseup', this.onDragEnd);
    document.removeEventListener('touchend', this.onDragEnd);
  };
}
