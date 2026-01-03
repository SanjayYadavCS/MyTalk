import { Injectable } from '@angular/core';
import { SignalRService } from './signalr.service';

@Injectable({ providedIn: 'root' })
export class WebRTCService {
    private peerConnection: RTCPeerConnection | null = null;
    private localStream: MediaStream | null = null;
    private currentTargetId: string = '';
    private candidatesQueue: RTCIceCandidateInit[] = [];

    private config: RTCConfiguration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' }
        ]
    };

    constructor(private signalR: SignalRService) {
        this.signalR.signalReceived.subscribe(async signal => {
            await this.handleSignal(signal.data, signal.senderId);
        });
    }

    public async startCall(targetUserId: string) {
        this.currentTargetId = targetUserId;
        this.createPeerConnection();

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.localStream.getTracks().forEach(track => {
                if (this.localStream) this.peerConnection?.addTrack(track, this.localStream);
            });

            const offer = await this.peerConnection!.createOffer();
            await this.peerConnection!.setLocalDescription(offer);

            await this.signalR.sendSignal({ type: 'offer', sdp: offer }, targetUserId);
        } catch (e) {
            console.error('Error starting call:', e);
        }
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
            console.log('Track received', event.streams);
            const audio = new Audio();
            audio.srcObject = event.streams[0];
            audio.autoplay = true;
            audio.play().catch(e => console.warn('Autoplay prevented', e));
        };
    }

    private async handleSignal(data: any, senderId: string) {
        if (data.type === 'offer') {
            this.currentTargetId = senderId;
            this.createPeerConnection();

            await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(data.sdp));
            await this.processQueue();

            // AUTO ANSWER logic for Receiver (One-Way)
            const answer = await this.peerConnection!.createAnswer();
            await this.peerConnection!.setLocalDescription(answer);

            await this.signalR.sendSignal({ type: 'answer', sdp: answer }, senderId);
        }
        else if (data.type === 'answer') {
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
