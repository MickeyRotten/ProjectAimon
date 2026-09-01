import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the Vite build (`dist/`) into a native Android shell. The
// whole game ships inside the APK, so it runs offline — the only thing that
// reaches the network is the LLM narrator, which needs it anyway. No hosting,
// no service worker, no Digital Asset Links: `webDir` is the build output and
// the WebView loads it from local files.
const config: CapacitorConfig = {
  appId: 'com.mickeyrotten.aimon',
  appName: 'Aimon',
  webDir: 'dist',
};

export default config;
