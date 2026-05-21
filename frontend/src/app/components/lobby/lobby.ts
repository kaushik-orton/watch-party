import { Component, inject, signal, HostListener } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SignalingService } from '../../services/signaling.service';

@Component({
  selector: 'app-lobby',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './lobby.html',
  styleUrl: './lobby.css'
})
export class LobbyComponent {
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private signalingService = inject(SignalingService);

  public username = signal('');
  public roomId = signal('');
  public isJoining = signal(false);

  // Parallax properties
  public mouseX = signal(0);
  public mouseY = signal(0);
  public cardTransform = signal('perspective(1000px) rotateX(0deg) rotateY(0deg) translateY(0px)');

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent) {
    const x = (event.clientX / window.innerWidth - 0.5) * 20; // max 10deg
    const y = (event.clientY / window.innerHeight - 0.5) * 20;
    
    // Smoothly apply transform
    this.cardTransform.set(`perspective(1000px) rotateX(${-y}deg) rotateY(${x}deg) scale3d(1.02, 1.02, 1.02)`);
  }
  
  @HostListener('document:mouseleave')
  onMouseLeave() {
    this.cardTransform.set('perspective(1000px) rotateX(0deg) rotateY(0deg) translateY(0px)');
  }

  constructor() {
    // Pre-fill Room ID if present in the URL query params
    this.route.queryParams.subscribe(params => {
      if (params['room']) {
        this.roomId.set(params['room']);
        this.isJoining.set(true);
      }
    });
  }

  public onSubmit() {
    if (!this.username().trim()) return;

    let targetRoomId = this.roomId().trim();
    if (!targetRoomId) {
      // Create a random room ID
      targetRoomId = Math.random().toString(36).substring(2, 9).toUpperCase();
    }

    this.signalingService.joinRoom(targetRoomId, this.username());
    this.router.navigate(['/room', targetRoomId]);
  }
}
