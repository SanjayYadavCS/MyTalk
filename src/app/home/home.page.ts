import { Component } from '@angular/core';
import { SignalRService } from '../services/signalr.service';
import { WebRTCService } from '../services/webrtc.service';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage {
  myId: string = '';
  targetId: string = '';
  isRegistered = false;

  constructor(
    private signalR: SignalRService,
    private webRTC: WebRTCService
  ) { }

  register() {
    if (this.myId) {
      this.signalR.register(this.myId).then(() => {
        this.isRegistered = true;
      });
    }
  }

  startAnnouncement() {
    if (this.targetId) {
      this.webRTC.startCall(this.targetId);
    }
  }
}
