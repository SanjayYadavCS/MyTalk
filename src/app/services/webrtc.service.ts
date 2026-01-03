import { Injectable } from '@angular/core';
import { SignalRService } from './signalr.service';
import { BehaviorSubject, Subject } from 'rxjs';
import { KeepAwake } from '@capacitor-community/keep-awake';

export type CallMode = 'announcement' | 'call';
export type CallStatus = 'idle' | 'calling' | 'ringing' | 'connected';

@Injectable({ providedIn: 'root' })
export class WebRTCService {
    private peerConnection: RTCPeerConnection | null = null;
    private localStream: MediaStream | null = null;
    private currentTargetId: string = '';
    private candidatesQueue: RTCIceCandidateInit[] = [];
    public isCallActive = new BehaviorSubject<boolean>(false);
    public callStatus = new BehaviorSubject<CallStatus>('idle');
    public incomingCall = new Subject<{ senderId: string, mode: CallMode, offerSdp: any }>();
    public currentTargetId$ = new BehaviorSubject<string>('');
    public isRecordMode$ = new BehaviorSubject<boolean>(false);

    private recorder: MediaRecorder | null = null;
    private recordedChunks: Blob[] = [];
    public onMessageSaved = new Subject<{ blob: Blob, senderId: string, timestamp: Date }>();

    private currentMode: CallMode = 'announcement';

    private config: RTCConfiguration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };

    constructor(private signalR: SignalRService) {
        this.signalR.signalReceived.subscribe(async signal => {
            await this.handleSignal(signal.data, signal.senderId);
        });
    }

    public async startCall(targetUserId: string, mode: CallMode) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('WebRTC requires a secure context (HTTPS or localhost).');
            return;
        }

        this.currentTargetId = targetUserId;
        this.currentTargetId$.next(targetUserId);
        this.currentMode = mode;
        this.createPeerConnection();

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.localStream.getTracks().forEach(track => {
                if (this.localStream) this.peerConnection?.addTrack(track, this.localStream);
            });

            const offer = await this.peerConnection!.createOffer();
            await this.peerConnection!.setLocalDescription(offer);

            await this.signalR.sendSignal({ type: 'offer', sdp: offer, mode: mode }, targetUserId);
            this.isCallActive.next(true);
            this.callStatus.next('calling');
            try { await KeepAwake.keepAwake(); } catch (e) { }
        } catch (e) {
            console.error('Error starting call:', e);
            alert('Could not access microphone.');
            this.cleanup();
        }
    }

    public async acceptCall(senderId: string, mode: CallMode, offerSdp: any) {
        this.currentTargetId = senderId;
        this.currentTargetId$.next(senderId);
        this.currentMode = mode;
        this.createPeerConnection();
        try { await KeepAwake.keepAwake(); } catch (e) { }

        try {
            await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(offerSdp));
            await this.processQueue();

            if (mode === 'call') {
                // Return Audio for two-way
                this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                this.localStream.getTracks().forEach(track => {
                    if (this.localStream) this.peerConnection?.addTrack(track, this.localStream);
                });
            }

            const answer = await this.peerConnection!.createAnswer();
            await this.peerConnection!.setLocalDescription(answer);
            await this.peerConnection!.setLocalDescription(answer);
            await this.signalR.sendSignal({ type: 'answer', sdp: answer }, senderId);
            this.isCallActive.next(true);
            this.callStatus.next('connected');
        } catch (e) {
            console.error('Error accepting call:', e);
            this.cleanup();
        }
    }

    public async rejectCall(senderId: string) {
        await this.signalR.sendSignal({ type: 'call_rejected' }, senderId);
        this.cleanup();
    }

    public async endCall() {
        if (this.currentTargetId) {
            await this.signalR.sendSignal({ type: 'call_end' }, this.currentTargetId);
        }
        this.cleanup();
    }

    private cleanup() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }
        this.currentTargetId = '';
        this.currentTargetId$.next('');
        this.candidatesQueue = [];
        this.isCallActive.next(false);
        this.stopRecording();
        try { KeepAwake.allowSleep(); } catch (e) { }
    }

    private createPeerConnection() {
        if (this.peerConnection) this.peerConnection.close();
        this.candidatesQueue = [];
        this.peerConnection = new RTCPeerConnection(this.config);

        this.peerConnection.onicecandidate = event => {
            if (event.candidate && this.currentTargetId) {
                this.signalR.sendSignal({ type: 'candidate', candidate: event.candidate }, this.currentTargetId);
            }
        };

        this.peerConnection.ontrack = event => {
            const stream = event.streams[0];

            if (this.isRecordMode$.value && this.currentMode === 'announcement') {
                console.log('Record mode active: intercepting audio');
                this.startRecording(stream, this.currentTargetId);
            } else {
                const audio = new Audio();
                audio.srcObject = stream;
                audio.autoplay = true;
                audio.play().catch(e => console.warn('Autoplay prevented', e));
            }
        };
    }

    private startRecording(stream: MediaStream, senderId: string) {
        this.recordedChunks = [];

        let mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = 'audio/ogg';
        }
        if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = 'audio/mp4';
        }

        try {
            this.recorder = new MediaRecorder(stream, { mimeType });
            this.recorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.recordedChunks.push(e.data);
            };
            this.recorder.onstop = () => {
                const blob = new Blob(this.recordedChunks, { type: mimeType });
                this.onMessageSaved.next({ blob, senderId, timestamp: new Date() });
            };
            this.recorder.start();
        } catch (err) {
            console.error('MediaRecorder failed:', err);
        }
    }

    private stopRecording() {
        if (this.recorder && this.recorder.state !== 'inactive') {
            this.recorder.stop();
        }
    }

    private async handleSignal(data: any, senderId: string) {
        if (data.type === 'call_end' || data.type === 'call_rejected') {
            this.cleanup();
            return;
        }

        if (data.type === 'offer') {
            if (data.mode === 'announcement') {
                // Auto-accept announcements
                await this.acceptCall(senderId, 'announcement', data.sdp);
            } else {
                // Show Incoming Call UI for mode 'call'
                this.signalR.sendSignal({ type: 'ringing' }, senderId); // Tell caller we are ringing
                this.incomingCall.next({ senderId, mode: data.mode, offerSdp: data.sdp } as any);
                this.callStatus.next('ringing');
            }
        }
        else if (data.type === 'ringing') {
            this.callStatus.next('ringing');
        }
        else if (data.type === 'answer') {
            this.callStatus.next('connected');
            await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(data.sdp));
            await this.processQueue();
        }
        else if (data.type === 'candidate') {
            if (this.peerConnection && this.peerConnection.remoteDescription) {
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            } else {
                this.candidatesQueue.push(data.candidate);
            }
        }
    }

    private async processQueue() {
        while (this.candidatesQueue.length > 0) {
            const candidate = this.candidatesQueue.shift();
            if (candidate) await this.peerConnection!.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }
}
