import React from 'react';
import { SafeAreaView } from 'react-native';
import { WebView } from 'react-native-webview';

export default function App() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <WebView
        source={{ uri: 'https://stranger-chat-1-bbdh.onrender.com' }}
        javaScriptEnabled
        domStorageEnabled
      />
    </SafeAreaView>
  );
}