#!/usr/bin/env node

/**
 * CLI tool to view BLE connection metrics and health report
 */

async function fetchMetrics() {
  const port = process.env.BLE_MCP_HTTP_PORT || 8081;
  const url = `http://localhost:${port}/metrics`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Failed to fetch metrics from ${url}:`, error.message);
    console.error('\nMake sure the observability server is running:');
    console.error('  pnpm start');
    process.exit(1);
  }
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

function printMetrics(data) {
  const { metrics } = data;
  
  console.log('\n📊 BLE Connection Metrics');
  console.log('═'.repeat(60));
  
  // Connection Stats
  console.log('\n🔌 Connections:');
  console.log(`  Total: ${metrics.connections.total}`);
  console.log(`  Successful: ${metrics.connections.successful}`);
  console.log(`  Failed: ${metrics.connections.failed}`);
  console.log(`  Failure Rate: ${(parseFloat(metrics.connections.failureRate) * 100).toFixed(1)}%`);
  
  // Reconnection Stats
  console.log('\n🔄 Reconnections:');
  console.log(`  Total: ${metrics.reconnections.total}`);
  if (Object.keys(metrics.reconnections.bySession).length > 0) {
    console.log('  By Session:');
    for (const [sessionId, count] of Object.entries(metrics.reconnections.bySession)) {
      const flag = count > 10 ? ' ⚠️' : '';
      console.log(`    ${sessionId}: ${count} reconnections${flag}`);
    }
  }
  
  // Resource Usage
  console.log('\n💾 Resources:');
  console.log(`  Max Listeners: ${metrics.resources.maxListeners}`);
  console.log(`  Max Peripherals: ${metrics.resources.maxPeripherals}`);
  console.log(`  Listener Warnings: ${metrics.resources.listenerWarnings}`);
  console.log(`  Resource Leak Detected: ${metrics.resources.leakDetected ? '⚠️ YES' : '✅ NO'}`);
  console.log(`  Zombie Connections: ${metrics.resources.zombieConnections}`);
  console.log(`  Bluetooth Restarts: ${metrics.resources.bluetoothRestarts}`);
  
  // Sessions
  console.log('\n🎯 Sessions:');
  console.log(`  Active: ${metrics.sessions.active}`);
  console.log(`  Total: ${metrics.sessions.total}`);
  console.log(`  Average Duration: ${formatDuration(metrics.sessions.averageDuration)}`);
  
  // Timing
  console.log('\n⏱️  Timing:');
  console.log(`  Average Connection Time: ${metrics.timing.averageConnectionTime}ms`);
  console.log(`  Last Connection Time: ${metrics.timing.lastConnectionTime}ms`);
  console.log(`  Uptime: ${formatDuration(metrics.timing.uptimeSeconds)}`);
  
  // Health Report
  const { health } = metrics;
  console.log('\n🏥 Health Report:');
  console.log(`  Status: ${health.healthy ? '✅ Healthy' : '⚠️ Issues Detected'}`);
  
  if (health.issues && health.issues.length > 0) {
    console.log('  Issues:');
    health.issues.forEach(issue => {
      console.log(`    • ${issue}`);
    });
  }
  
  if (health.recommendations && health.recommendations.length > 0) {
    console.log('  Recommendations:');
    health.recommendations.forEach(rec => {
      console.log(`    • ${rec}`);
    });
  }
  
  // Resource Leak Analysis
  console.log('\n🔍 Resource Leak Analysis:');
  const safeConnections = parseInt(health.recommendations?.[0]?.match(/\d+/)?.[0] || '100');
  const currentRate = metrics.reconnections.total > 0 
    ? metrics.connections.total / metrics.reconnections.total 
    : 0;
  
  console.log(`  Estimated safe connections: ${safeConnections}`);
  console.log(`  Current connection/reconnect ratio: ${currentRate.toFixed(1)}`);
  
  if (metrics.resources.zombieConnections > 0) {
    const zombieRate = metrics.connections.total / metrics.resources.zombieConnections;
    console.log(`  Zombie appears every ~${Math.floor(zombieRate)} connections`);
  }
  
  if (metrics.resources.listenerWarnings > 0) {
    console.log(`  ⚠️ Listener leak detected - ${metrics.resources.listenerWarnings} warnings`);
  }
  
  // Bridge restart correlation
  console.log('\n🔄 Bridge Restart Analysis:');
  console.log('  scripts/ble-soak.js reports bridgeRestarts, watching the process');
  console.log('  on the WS port. If restarts correlate with zombie connections,');
  console.log('  it indicates critical resource exhaustion.');
  
  console.log('\n' + '═'.repeat(60));
}

// Main execution
(async () => {
  const data = await fetchMetrics();
  printMetrics(data);
})();