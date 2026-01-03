import { Component, OnDestroy, OnInit, NgZone } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { SignalRService, UserProfile } from '../services/signalr.service';
import { WebRTCService, CallMode, CallStatus } from '../services/webrtc.service';
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
  callStatus: CallStatus = 'idle';
  currentTargetId = '';

  onlineUsers: string[] = [];
  offlineProfiles: UserProfile[] = [];
  allProfiles: UserProfile[] = [];
  myProfile: UserProfile | null = null;
  searchQuery: string = '';
  selectedTab: 'active' | 'contacts' | 'dialer' = 'active';
  incomingCall: { senderId: string, mode: CallMode, offerSdp: any } | null = null;
  connectionStatus: 'connected' | 'connecting' | 'disconnected' = 'disconnected';

  callDuration = '00:00';
  isRecordMode = false;
  savedMessages: SavedMessage[] = [];

  // Ringtone and Slider
  private ringtone = new Audio('https://assets.mixkit.co/active_storage/sfx/1359/1359-preview.mp3');
  sliderValue: number = 50; // 0 = Reject, 50 = Neutral, 100 = Accept

  private timerSub: Subscription | null = null;
  private startTime: number = 0;
  private pendingAutoAccept = false;

  constructor(
    private signalR: SignalRService,
    private webRTC: WebRTCService,
    private zone: NgZone,
    private sanitizer: DomSanitizer
  ) {
    this.webRTC.isCallActive.subscribe(status => {
      this.zone.run(() => {
        this.isCallActive = status;
        if (!status) {
          this.stopTimer();
        }
      });
    });

    this.webRTC.callStatus.subscribe(status => {
      this.zone.run(() => {
        this.callStatus = status;
        if (status === 'connected') {
          this.startTimer();
        }
      });
    });

    this.webRTC.currentTargetId$.subscribe(id => {
      this.zone.run(() => this.currentTargetId = id);
    });

    this.signalR.onlineUsers.subscribe(users => {
      this.zone.run(() => {
        this.onlineUsers = users.filter(u => u !== this.myId);
        this.updateOfflineUsers();
      });
    });

    this.signalR.allKnownProfiles.subscribe(profiles => {
      this.zone.run(() => {
        this.allProfiles = profiles;
        this.updateOfflineUsers();
      });
    });

    this.signalR.myProfile.subscribe(profile => {
      this.zone.run(() => this.myProfile = profile);
    });

    this.webRTC.incomingCall.subscribe(call => {
      this.zone.run(() => {
        this.incomingCall = call as any;

        if (this.pendingAutoAccept && this.incomingCall && this.incomingCall.senderId === call.senderId) {
          console.log("Auto-accepting incoming call...");
          this.acceptCall();
          this.pendingAutoAccept = false;
        } else {
          this.sliderValue = 50;
          this.playRingtone();
        }
      });
    });

    this.signalR.pushCallReceived.subscribe(data => {
      this.zone.run(() => {
        // Only trigger if we aren't already in a call or already showing a ringer
        if (!this.isCallActive && !this.incomingCall) {
          this.incomingCall = {
            senderId: data.callerId,
            mode: 'call',
            offerSdp: null
          };

          if (data.autoAnswer) {
            this.pendingAutoAccept = true;
            // Maybe show a spinner? The incomingCall UI will show briefly until Register completes and offer arrives
            this.sliderValue = 95; // Visual cue
          } else {
            this.sliderValue = 50;
            this.playRingtone();
          }
        }
      });
    });
    this.signalR.connectionStatus$.subscribe(status => {
      this.zone.run(() => this.connectionStatus = status);
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

  async register() {
    if (this.myId) {
      const name = localStorage.getItem('myName') || this.myId;
      await this.signalR.register(this.myId, name);
      this.zone.run(() => {
        this.isRegistered = true;
        this.saveData();
      });
    }
  }

  async editName() {
    const newName = prompt("Enter your name:", this.myProfile?.name || "");
    if (newName) {
      await this.signalR.updateProfile(newName);
    }
  }

  getProfile(userId: string): UserProfile | undefined {
    return this.allProfiles.find(p => p.userId === userId);
  }

  setTab(tab: 'active' | 'contacts' | 'dialer') {
    this.selectedTab = tab;
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

  async handleRefresh(event: any) {
    await this.signalR.manualReconnect();
    setTimeout(() => {
      event.target.complete();
    }, 1000);
  }

  updateOfflineUsers() {
    const online = this.signalR.onlineUsers.value;
    this.offlineProfiles = this.allProfiles.filter(p => p.userId !== this.myId && !online.includes(p.userId));
  }

  isUserOnline(userId: string): boolean {
    return this.onlineUsers.includes(userId);
  }

  async checkCors() {
    try {
      const result = await this.signalR.testCors();
      alert('CORS Success: ' + JSON.stringify(result));
    } catch (err) {
      alert('CORS Failed: ' + err);
    }
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
