import { Component, OnDestroy, OnInit, NgZone } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { SignalRService } from '../services/signalr.service';
import { WebRTCService, CallMode } from '../services/webrtc.service';
import { Subscription, interval } from 'rxjs';

interface SavedMessage {
  senderId: string;
  url: SafeUrl | string;
  rawUrl?: string;
  timestamp: Date;
}

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage implements OnInit, OnDestroy {
  myId: string = '';
  isRegistered = false;
  isCallActive = false;
  currentTargetId = '';

  onlineUsers: string[] = [];
  incomingCall: { senderId: string, mode: CallMode, offerSdp: any } | null = null;

  callDuration = '00:00';
  isRecordMode = false;
  savedMessages: SavedMessage[] = [];

  // Ringtone and Slider
  private ringtone = new Audio('https://assets.mixkit.co/active_storage/sfx/1359/1359-preview.mp3');
  sliderValue: number = 50; // 0 = Reject, 50 = Neutral, 100 = Accept

  private timerSub: Subscription | null = null;
  private startTime: number = 0;

  constructor(
    private signalR: SignalRService,
    private webRTC: WebRTCService,
    private zone: NgZone,
    private sanitizer: DomSanitizer
  ) {
    this.webRTC.isCallActive.subscribe(status => {
      this.zone.run(() => {
        this.isCallActive = status;
        if (status) {
          this.startTimer();
        } else {
          this.stopTimer();
        }
      });
    });

    this.webRTC.currentTargetId$.subscribe(id => {
      this.zone.run(() => this.currentTargetId = id);
    });

    this.signalR.onlineUsers.subscribe(users => {
      this.zone.run(() => this.onlineUsers = users.filter(u => u !== this.myId));
    });

    this.webRTC.incomingCall.subscribe(call => {
      this.zone.run(() => {
        this.incomingCall = call as any;
        this.sliderValue = 50;
        this.playRingtone();
      });
    });

    this.webRTC.onMessageSaved.subscribe(async msg => {
      const base64 = await this.blobToBase64(msg.blob);
      const safeUrl = this.sanitizer.bypassSecurityTrustUrl(base64);
      this.zone.run(() => {
        this.savedMessages.unshift({
          senderId: msg.senderId,
          url: safeUrl,
          rawUrl: base64,
          timestamp: msg.timestamp
        });
        this.saveData();
      });
    });
  }

  ngOnInit() {
    this.loadData();
  }

  private async blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  }

  private saveData() {
    localStorage.setItem('myId', this.myId);
    localStorage.setItem('isRegistered', JSON.stringify(this.isRegistered));
    localStorage.setItem('isRecordMode', JSON.stringify(this.isRecordMode));

    const toSave = this.savedMessages.slice(0, 10).map((m: any) => ({
      senderId: m.senderId,
      url: m.rawUrl || m.url,
      timestamp: m.timestamp
    }));
    localStorage.setItem('savedMessages', JSON.stringify(toSave));
  }

  private loadData() {
    this.myId = localStorage.getItem('myId') || '';
    this.isRecordMode = JSON.parse(localStorage.getItem('isRecordMode') || 'false');
    this.webRTC.isRecordMode$.next(this.isRecordMode);

    const saved = localStorage.getItem('savedMessages');
    if (saved) {
      const parsed = JSON.parse(saved);
      this.savedMessages = parsed.map((m: any) => ({
        ...m,
        rawUrl: m.url,
        url: this.sanitizer.bypassSecurityTrustUrl(m.url)
      }));
    }

    const wasRegistered = JSON.parse(localStorage.getItem('isRegistered') || 'false');
    if (wasRegistered && this.myId) {
      this.register();
    }
  }

  register() {
    if (this.myId) {
      this.signalR.register(this.myId).then(() => {
        this.zone.run(() => {
          this.isRegistered = true;
          this.saveData();
        });
      });
    }
  }

  startCall(targetId: string, mode: CallMode) {
    this.webRTC.startCall(targetId, mode);
  }

  acceptCall() {
    if (this.incomingCall) {
      this.stopRingtone();
      this.webRTC.acceptCall(this.incomingCall.senderId, this.incomingCall.mode, this.incomingCall.offerSdp);
      this.incomingCall = null;
    }
  }

  rejectCall() {
    if (this.incomingCall) {
      this.stopRingtone();
      this.webRTC.rejectCall(this.incomingCall.senderId);
      this.incomingCall = null;
    }
  }

  onSliderChange(event: any) {
    const val = event.detail.value;
    if (val >= 90) {
      this.acceptCall();
    } else if (val <= 10) {
      this.rejectCall();
    } else {
      // Snap back
      setTimeout(() => this.sliderValue = 50, 300);
    }
  }

  private playRingtone() {
    this.ringtone.loop = true;
    this.ringtone.play().catch(e => console.log('Ringtone auto-play blocked', e));
  }

  private stopRingtone() {
    this.ringtone.pause();
    this.ringtone.currentTime = 0;
  }

  stopCall() {
    this.webRTC.endCall();
  }

  toggleRecordMode() {
    this.isRecordMode = !this.isRecordMode;
    this.webRTC.isRecordMode$.next(this.isRecordMode);
    this.saveData();
  }

  logout() {
    this.webRTC.endCall();
    this.signalR.disconnect();
    this.isRegistered = false;
    this.myId = '';
    localStorage.clear();
  }

  private startTimer() {
    this.startTime = Date.now();
    this.timerSub = interval(1000).subscribe(() => {
      this.zone.run(() => {
        const diff = Math.floor((Date.now() - this.startTime) / 1000);
        const minutes = Math.floor(diff / 60).toString().padStart(2, '0');
        const seconds = (diff % 60).toString().padStart(2, '0');
        this.callDuration = `${minutes}:${seconds}`;
      });
    });
  }

  private stopTimer() {
    if (this.timerSub) {
      this.timerSub.unsubscribe();
      this.timerSub = null;
    }
    this.callDuration = '00:00';
  }

  ngOnDestroy() {
    this.stopTimer();
  }
}
