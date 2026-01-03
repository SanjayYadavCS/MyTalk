import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { BehaviorSubject, Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class SignalRService {
  private hubConnection!: signalR.HubConnection;
  public signalReceived = new Subject<{ data: any, senderId: string }>();
  public connectionId = new BehaviorSubject<string>('');
  public onlineUsers = new BehaviorSubject<string[]>([]);
  public isConnected = new BehaviorSubject<boolean>(false);

  private startPromise: Promise<void> | null = null;

  constructor() {
    this.createConnection();
    this.startConnection();
  }

  private createConnection() {
    this.hubConnection = new signalR.HubConnectionBuilder()
      .withUrl("http://localhost:5059/hubs/signaling")
      .withAutomaticReconnect()
      .build();

    this.hubConnection.on("ReceiveSignal", (data: any, senderId: string) => {
      this.signalReceived.next({ data, senderId });
    });

    this.hubConnection.on("UserListUpdated", (users: string[]) => {
      this.onlineUsers.next(users);
    });

    this.hubConnection.onclose(() => this.isConnected.next(false));
    this.hubConnection.onreconnected(() => this.isConnected.next(true));
  }

  private startConnection() {
    this.startPromise = this.hubConnection
      .start()
      .then(() => {
        console.log('SignalR Connection started');
        this.connectionId.next(this.hubConnection.connectionId || '');
        this.isConnected.next(true);
      })
      .catch(err => {
        console.log('Error while starting connection: ' + err);
        this.isConnected.next(false);
      });
  }

  private async ensureConnected() {
    if (this.hubConnection.state === signalR.HubConnectionState.Disconnected) {
      this.startConnection();
    }
    await this.startPromise;
  }

  public async sendSignal(data: any, targetUserId: string) {
    try {
      await this.ensureConnected();
      await this.hubConnection.invoke("SendSignal", data, targetUserId);
    } catch (err) {
      console.error('Error sending signal:', err);
    }
  }

  public async register(userId: string) {
    try {
      await this.ensureConnected();
      await this.hubConnection.invoke("Register", userId);
    } catch (err) {
      console.error('Error registering:', err);
    }
  }

  public async disconnect() {
    if (this.hubConnection) {
      await this.hubConnection.stop();
      this.connectionId.next('');
      this.isConnected.next(false);
    }
  }
}
