import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { BehaviorSubject, Subject } from 'rxjs';
import { PushNotifications } from '@capacitor/push-notifications';
import { Device } from '@capacitor/device';
import { CapacitorHttp } from '@capacitor/core';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export interface UserProfile {
  userId: string;
  name: string;
  phoneNumber: string;
}

@Injectable({
  providedIn: 'root'
})
export class SignalRService {
  private hubConnection!: signalR.HubConnection;
  public signalReceived = new Subject<{ data: any, senderId: string }>();
  public pushCallReceived = new Subject<{ callerId: string, callerName: string, callerNumber: string, autoAnswer?: boolean }>();
  public connectionId = new BehaviorSubject<string>('');
  public onlineUsers = new BehaviorSubject<string[]>([]);
  public allKnownProfiles = new BehaviorSubject<UserProfile[]>([]);
  public myProfile = new BehaviorSubject<UserProfile | null>(null);
  public isConnected = new BehaviorSubject<boolean>(false);
  public connectionStatus$ = new BehaviorSubject<ConnectionStatus>('disconnected');
  private retryCount = 0;
  private readonly MAX_RETRIES = 5;

  private startPromise: Promise<void> | null = null;
  private lastRegisteredUserId: string | null = null;

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
      const savedId = localStorage.getItem('myId');
      if (savedId) this.setDeviceToken(savedId, token.value);
    });

    // Create the High Priority Channel for Android
    await PushNotifications.createChannel({
      id: 'calls',
      name: 'Incoming Calls',
      description: 'Notifications for incoming voice and video calls',
      importance: 5, // High
      visibility: 1, // Public
      sound: 'default', // or a custom sound name if you added one
      vibration: true
    });

    // Register Action Types (Accept/Reject) - Casting to any to bypass potential type mismatch in older plugins
    (PushNotifications as any).registerActionTypes({
      types: [
        {
          id: 'CALL_INVITE',
          actions: [
            { id: 'accept', title: 'Accept', foreground: true },
            { id: 'decline', title: 'Decline', foreground: false, destructive: true }
          ]
        }
      ]
    });

    PushNotifications.addListener('registrationError', (error: any) => {
      console.error('Error on registration: ' + JSON.stringify(error));
    });

    // Handle button clicks from the notification tray
    PushNotifications.addListener('pushNotificationActionPerformed', (notification) => {
      console.log('Push action performed:', notification.actionId);
      const data = notification.notification.data;

      if (data && data.type === 'incoming_call') {
        const autoAnswer = notification.actionId === 'accept';

        // App will move to foreground, trigger the pushCallReceived to show UI
        this.pushCallReceived.next({
          callerId: data.callerId,
          callerName: data.callerName,
          callerNumber: data.callerNumber,
          autoAnswer: autoAnswer
        });

        if (notification.actionId === 'decline') {
          // Send reject signal if possible
          if (data.callerId) {
            this.sendSignal({ type: 'reject' }, data.callerId);
          }
        } else {
          this.ensureConnected();
        }
      }
    });

    // Handle the notification arrival while the app is open or background
    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      console.log('Push received:', notification);
      const data = notification.data;

      if (data && data.type === 'incoming_call') {
        console.log('Incoming call via Push detected!');
        this.pushCallReceived.next({
          callerId: data.callerId,
          callerName: data.callerName,
          callerNumber: data.callerNumber
        });
        this.ensureConnected();
      }
    });
  }

  private currentFcmToken: string = '';

  private createConnection() {
    this.hubConnection = new signalR.HubConnectionBuilder()
      .withUrl("http://192.168.0.104:5059/hubs/signaling")
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: retryContext => {
          return Math.min(10000, 1000 * retryContext.previousRetryCount);
        }
      })
      .build();

    this.hubConnection.on("ReceiveSignal", (data: any, senderId: string) => {
      this.signalReceived.next({ data, senderId });
    });

    this.hubConnection.on("UserListUpdated", (online: string[], profiles: UserProfile[]) => {
      this.onlineUsers.next(online);
      this.allKnownProfiles.next(profiles);

      const savedId = localStorage.getItem('myId');
      if (savedId) {
        const myProf = profiles.find(p => p.userId === savedId);
        if (myProf) this.myProfile.next(myProf);
      }
    });

    this.hubConnection.onclose(() => {
      this.isConnected.next(false);
      this.connectionStatus$.next('disconnected');
    });

    this.hubConnection.onreconnecting(() => {
      this.connectionStatus$.next('connecting');
    });

    this.hubConnection.onreconnected(() => {
      this.isConnected.next(true);
      this.connectionStatus$.next('connected');
      if (this.lastRegisteredUserId) {
        this.register(this.lastRegisteredUserId);
      }
    });
  }

  private startConnection(): Promise<void> {
    if (this.hubConnection.state === signalR.HubConnectionState.Connected) {
      return Promise.resolve();
    }
    if (this.startPromise && this.hubConnection.state === signalR.HubConnectionState.Connecting) {
      return this.startPromise;
    }

    this.connectionStatus$.next('connecting');
    this.startPromise = this.hubConnection.start()
      .then(() => {
        console.log('SignalR Connection started');
        this.retryCount = 0;
        this.connectionId.next(this.hubConnection.connectionId || '');
        this.isConnected.next(true);
        this.connectionStatus$.next('connected');
        this.startPromise = null;
      })
      .catch(err => {
        this.startPromise = null;
        console.log('Error while starting connection: ' + err);
        this.isConnected.next(false);

        if (this.retryCount < this.MAX_RETRIES) {
          this.retryCount++;
          this.connectionStatus$.next('connecting');
          console.log(`Retrying connection (${this.retryCount}/${this.MAX_RETRIES})...`);
          setTimeout(() => this.startConnection(), 5000);
        } else {
          this.connectionStatus$.next('disconnected');
          console.log('Max retries reached. Connection stopped.');
        }
        throw err;
      });

    return this.startPromise;
  }

  public async manualReconnect() {
    this.retryCount = 0; // Reset counter for manual action
    if (this.hubConnection.state !== signalR.HubConnectionState.Disconnected) {
      await this.hubConnection.stop();
    }
    return this.startConnection();
  }

  public async testCors() {
    try {
      const options = {
        url: 'http://192.168.0.104:5059/test-cors',
      };

      const response = await CapacitorHttp.get(options);
      console.log('CORS Native Test Result:', response);

      if (response.status === 200) {
        return response.data;
      } else {
        throw new Error(`Server returned status ${response.status}`);
      }
    } catch (err) {
      console.error('CORS Native Test Failed:', err);
      throw err;
    }
  }

  private async ensureConnected() {
    if (this.hubConnection.state === signalR.HubConnectionState.Connected) {
      return;
    }

    try {
      await this.startConnection();
    } catch (e) {
      throw new Error("Connection is not active (State: " + this.hubConnection.state + ")");
    }
  }

  public async sendSignal(data: any, targetUserId: string) {
    try {
      await this.ensureConnected();
      await this.hubConnection.invoke("SendSignal", data, targetUserId);
    } catch (err) {
      console.error('Error sending signal:', err);
    }
  }

  public async register(userId: string, name?: string) {
    try {
      this.lastRegisteredUserId = userId;
      await this.ensureConnected();
      const profile = await this.hubConnection.invoke<UserProfile>("Register", userId, name || localStorage.getItem('myName'));
      if (profile) {
        this.myProfile.next(profile);
      }
      if (this.currentFcmToken) {
        await this.setDeviceToken(userId, this.currentFcmToken);
      }
    } catch (err) {
      console.error('Error registering:', err);
    }
  }

  public async updateProfile(name: string) {
    try {
      await this.ensureConnected();
      await this.hubConnection.invoke("UpdateProfile", name);
      localStorage.setItem('myName', name);
    } catch (err) {
      console.error('Error updating profile:', err);
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
