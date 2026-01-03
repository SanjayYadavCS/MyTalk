import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { BehaviorSubject, Subject } from 'rxjs';
import { PushNotifications } from '@capacitor/push-notifications';
import { Device } from '@capacitor/device';

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
    this.setupPushNotifications();
  }

  private async setupPushNotifications() {
    const info = await Device.getInfo();
    if (info.platform === 'web') return; // Not for web browser

    // Request permission to use push notifications
    let perm = await PushNotifications.requestPermissions();
    if (perm.receive === 'granted') {
      await PushNotifications.register();
    }

    // On success, we should be able to receive notifications
    PushNotifications.addListener('registration', (token) => {
      console.log('Push registration success, token: ' + token.value);
      this.currentFcmToken = token.value;
      // If we are already logged in, update the token on the server
      const savedId = localStorage.getItem('myId');
      if (savedId) this.setDeviceToken(savedId, token.value);
    });

    PushNotifications.addListener('registrationError', (error: any) => {
      console.error('Error on registration: ' + JSON.stringify(error));
    });

    // Handle the notification arrival while the app is open
    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      console.log('Push received: ' + JSON.stringify(notification));
    });
  }

  private currentFcmToken: string = '';

  private createConnection() {
    this.hubConnection = new signalR.HubConnectionBuilder()
      .withUrl("http://192.168.0.104:5059/hubs/signaling")
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
      if (this.currentFcmToken) {
        await this.setDeviceToken(userId, this.currentFcmToken);
      }
    } catch (err) {
      console.error('Error registering:', err);
    }
  }

  public async setDeviceToken(userId: string, token: string) {
    try {
      await this.ensureConnected();
      await this.hubConnection.invoke("SetDeviceToken", userId, token);
    } catch (err) {
      console.error('Error setting FCM token:', err);
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
