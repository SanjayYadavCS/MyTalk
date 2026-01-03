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
      console.log('Signal received from ' + senderId);
      this.signalReceived.next({ data, senderId });
    });
  }

  private startConnection() {
    this.hubConnection
      .start()
      .then(() => {
        console.log('SignalR Connection started');
        this.connectionId.next(this.hubConnection.connectionId || '');
      })
      .catch(err => console.log('Error while starting connection: ' + err));
  }

  public async sendSignal(data: any, targetUserId: string) {
    try {
      await this.hubConnection.invoke("SendSignal", data, targetUserId);
    } catch (err) {
      console.error('Error sending signal:', err);
    }
  }

  public async register(userId: string) {
    try {
      await this.hubConnection.invoke("Register", userId);
    } catch (err) {
      console.error('Error registering:', err);
    }
  }
}
