import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.ionic.starter',
  appName: 'MyTalk.Client',
  webDir: 'www',
  server: {
    cleartext: true,
    allowNavigation: ['*'],
    androidScheme: 'http'
  },
  plugins: {
    CapacitorHttp: {
      enabled: false,
    },
    CapacitorCookies: {
      enabled: false,
    }
  }
};

export default config;
