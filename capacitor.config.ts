import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.ionic.starter',
  appName: 'MyTalk.Client',
  webDir: 'www',
  server: {
    cleartext: true,
    allowNavigation: ['192.168.0.104:5059']
  }
};

export default config;
