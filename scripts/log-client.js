#!/usr/bin/env node

import WebSocket from 'ws';

// Use WS_URL env var if set, otherwise default to localhost
const baseUrl = process.env.WS_URL || 'ws://localhost:8080';
const url = baseUrl.replace(/\/$/, '') + '?command=log-stream';

console.log(`Connecting to: ${url}`);

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('Connected to log stream\n');
});

ws.on('message', (data) => {
  try {
    const log = JSON.parse(data.toString());
    if (log.type === 'log') {
      const time = log.timestamp.split('T')[1].split('.')[0];
      const level = log.level.toUpperCase().padEnd(5);
      console.log(`[${time}] [${level}] ${log.message}`);
    }
  } catch (e) {
    console.log(data.toString());
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});

ws.on('close', () => {
  console.log('\nDisconnected from log stream');
  process.exit(0);
});

// Handle Ctrl+C
process.on('SIGINT', () => {
  ws.close();
  process.exit(0);
});