import { Amplify } from 'aws-amplify';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AiChatStreamProvider } from './AiChatStream';
import { App } from './App';
import { AppStateProvider } from './AppState';
import { AuthProvider } from './AuthState';
import amplifyOutputs from './amplify_outputs.json';
import './styles/app.css';

Amplify.configure(amplifyOutputs as Record<string, unknown>);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <AppStateProvider>
          <AiChatStreamProvider>
            <App />
          </AiChatStreamProvider>
        </AppStateProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
