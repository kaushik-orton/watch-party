import { Component, inject, signal, ViewChild, ElementRef, AfterViewInit, OnDestroy, effect, Injector } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
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
  private route = inject(ActivatedRoute);
  private injector = inject(Injector);

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
  public showScreenShareHelp = signal(true);
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  public isControlsMinimized = signal(false);
  public isControlsCollapsed = signal(false);
  public isWaitingBubbleCollapsed = signal(false);
  public isRemoteBubbleCollapsed = signal(false);


  // Floating bubbles draggable positions
  public localBubblePos = signal({ x: 20, y: 20 });
  public remoteBubblePos = signal({ x: 20, y: 200 });
  public controlsPos = signal({ x: window.innerWidth / 2 - 260, y: window.innerHeight - 120 });
  private activeDragging: 'local' | 'remote' | 'controls' | null = null;
  private dragOffset = { x: 0, y: 0 };

  // Floating emojis for reactions
  public reactionsList = signal<{ id: string; emoji: string; style: string }[]>([]);

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
    // If this page is opened directly (without joining via lobby),
    // there is no active peer/user state. Redirect to lobby with room code.
    if (!this.signalingService.currentUser()) {
      const roomId = this.route.snapshot.paramMap.get('id');
      this.router.navigate(['/'], roomId ? { queryParams: { room: roomId } } : undefined);
      return;
    }

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
    }, { injector: this.injector });

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
    }, { injector: this.injector });

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
    }, { injector: this.injector });

    effect(() => {
      const remoteScreen = this.signalingService.remoteScreenStream();
      if (remoteScreen) {
        setTimeout(() => {
          if (this.remoteVideoRef?.nativeElement) {
            this.remoteVideoRef.nativeElement.srcObject = remoteScreen;
            this.remoteVideoRef.nativeElement.play().catch((err) => {
              console.warn('Guest: Autoplay blocked for remote movie stream, retrying muted...', err);
              if (this.remoteVideoRef?.nativeElement) {
                this.remoteVideoRef.nativeElement.muted = true;
                this.remoteVideoRef.nativeElement.play().catch((playErr) => {
                  console.error('Guest: Muted autoplay also blocked:', playErr);
                });
              }
            });
          }
        }, 200);
      }
    }, { injector: this.injector });

    // Auto-scroll chat to bottom when messages update
    effect(() => {
      const messages = this.signalingService.chatMessages();
      if (messages.length > 0) {
        setTimeout(() => this.scrollToBottom(), 50);
      }
    }, { injector: this.injector });

    // Automatically start webcam when joining room
    this.signalingService.startLocalWebcam().then(stream => {
      setTimeout(() => {
        if (!stream) {
          const secureContextHint = window.isSecureContext
            ? 'Please allow camera permission in your browser site settings.'
            : 'Camera requires a secure context. Use localhost/HTTPS.';
          this.webcamError.set(`Camera and microphone are both required. ${secureContextHint}`);
        } else {
          this.webcamError.set('');
        }
      });
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
          // Capture stream (video + audio) from the video element at 24 FPS to keep the WebRTC stream active
          let stream: MediaStream;
          const anyVideoEl = videoElement as any;
          if (anyVideoEl.captureStream) {
            stream = anyVideoEl.captureStream(24);
          } else if (anyVideoEl.mozCaptureStream) {
            stream = anyVideoEl.mozCaptureStream(24);
          } else {
            console.error('Browser does not support captureStream()');
            return;
          }

          // Share this stream via the screen peer connection
          this.signalingService.setLocalFileStream(stream, file.name);
        };
      }
    }, 100);
  }

  // --- SUBTITLES ---
  public onSubtitleSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      const file = input.files[0];
      const reader = new FileReader();
      
      reader.onload = (e) => {
        let text = e.target?.result as string;
        
        // Convert basic SRT to WebVTT
        if (file.name.toLowerCase().endsWith('.srt')) {
          text = 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
        }
        
        const blob = new Blob([text], { type: 'text/vtt' });
        const url = URL.createObjectURL(blob);
        
        const videoElement = document.getElementById('watch-player') as HTMLVideoElement;
        if (videoElement) {
          // Remove existing track if any
          const existingTrack = videoElement.querySelector('track');
          if (existingTrack) {
            existingTrack.remove();
          }
          
          const track = document.createElement('track');
          track.kind = 'subtitles';
          track.label = 'Custom Subtitles';
          track.srclang = 'en';
          track.src = url;
          track.default = true;
          
          videoElement.appendChild(track);
          
          // Force track to show
          if (videoElement.textTracks && videoElement.textTracks.length > 0) {
             const t = videoElement.textTracks[videoElement.textTracks.length - 1];
             t.mode = 'showing';
          }
        }
      };
      
      reader.readAsText(file);
    }
    
    // Clear input so they can re-select the same file if needed
    input.value = '';
  }

  public searchSubtitlesOnline() {
    let filename = '';
    if (this.signalingService.currentUser()?.isHost) {
      filename = this.selectedVideoFileName();
    } else {
      filename = this.signalingService.remoteVideoFileName();
    }
    if (!filename) return;
    
    // Strip common video extensions
    let cleanName = filename.replace(/\.(mp4|mkv|webm|avi|mov)$/i, '');
    
    // Optional: replace dots with spaces for cleaner search (common in movie torrent names)
    cleanName = cleanName.replace(/\./g, ' ');
    
    // Encode for URL
    const query = encodeURIComponent(cleanName);
    
    // OpenSubtitles search URL
    const url = `https://www.opensubtitles.org/en/search/sublanguageid-all/moviename-${query}`;
    window.open(url, '_blank');
  }

  public handlePlay() {
    const videoElement = document.getElementById('watch-player') as HTMLVideoElement;
    if (videoElement) {
      this.signalingService.updatePlaybackState(true, videoElement.currentTime, videoElement.playbackRate);
    }
  }

  public handlePause() {
    const videoElement = document.getElementById('watch-player') as HTMLVideoElement;
    if (videoElement) {
      this.signalingService.updatePlaybackState(false, videoElement.currentTime, videoElement.playbackRate);
    }
  }

  public handleSeek() {
    const videoElement = document.getElementById('watch-player') as HTMLVideoElement;
    if (videoElement) {
      this.signalingService.updatePlaybackState(!videoElement.paused, videoElement.currentTime, videoElement.playbackRate);
    }
  }

  public guestTogglePlay() {
    const isPlaying = this.signalingService.playbackState().playing;
    // Send time as -1 to indicate NO SEEKING, just state change.
    this.signalingService.updatePlaybackState(!isPlaying, -1, 1);
  }

  // --- SCREEN SHARE CONTROL ---
  public startScreenSharing() {
    this.showScreenShareHelp.set(true);
    this.signalingService.startScreenShare();
    this.showShareMenu.set(false);
  }

  public stopScreenSharing() {
    this.signalingService.stopScreenShare();
    this.hasLocalFileLoaded.set(false);
    this.selectedVideoFileName.set('');
    this.showScreenShareHelp.set(true);
  }

  public closeScreenShareHelp() {
    this.showScreenShareHelp.set(false);
  }

  public openScreenShareHelp() {
    this.showScreenShareHelp.set(true);
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
    const style = `--duration: 1s;`;
    const newEmoji = { id, emoji, style };

    this.reactionsList.update(prev => [...prev, newEmoji]);

    setTimeout(() => {
      this.reactionsList.update(prev => prev.filter(r => r.id !== id));
    }, 1000);
  }

  // --- VIDEO ELEMENT HELPERS ---
  public onVideoLoaded(event: Event) {
    const video = event.target as HTMLVideoElement;
    if (video) {
      video.play().catch(() => {});
    }
  }

  public getPartnerName(): string {
    const partner = this.signalingService.users().find(u => u.id !== this.signalingService.currentUser()?.id);
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
      setTimeout(() => {
        if (!stream) {
          const secureContextHint = window.isSecureContext
            ? 'Please allow camera permission in your browser site settings.'
            : 'Camera requires a secure context. Use localhost/HTTPS.';
          this.webcamError.set(`Camera and microphone are both required. ${secureContextHint}`);
        } else {
          this.webcamError.set('');
        }
      });
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
      alert('Room invitation link copied to clipboard! Send it to your partner.');
    });
  }

  public exitRoom() {
    this.router.navigate(['/']);
  }

  // --- DRAG CONTROLS FOR BUBBLES ---
  public onDragStart(event: MouseEvent | TouchEvent, bubble: 'local' | 'remote' | 'controls') {
    event.preventDefault();
    this.activeDragging = bubble;
    
    const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
    const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;
    
    const currentPos = bubble === 'local'
      ? this.localBubblePos()
      : bubble === 'remote'
      ? this.remoteBubblePos()
      : this.controlsPos();
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
    } else if (this.activeDragging === 'remote') {
      this.remoteBubblePos.set({ x: newX, y: newY });
    } else {
      this.controlsPos.set({ x: newX, y: newY });
    }
  };

  public toggleControlBarCollapse() {
    this.isControlsCollapsed.set(!this.isControlsCollapsed());
    if (!this.isControlsCollapsed()) {
      this.isControlsMinimized.set(false);
    }
  }

  public toggleRemoteBubbleCollapse() {
    this.isRemoteBubbleCollapsed.set(!this.isRemoteBubbleCollapsed());
  }

  private onDragEnd = () => {
    this.activeDragging = null;
    document.removeEventListener('mousemove', this.onDragging);
    document.removeEventListener('touchmove', this.onDragging);
    document.removeEventListener('mouseup', this.onDragEnd);
    document.removeEventListener('touchend', this.onDragEnd);
  };
}
