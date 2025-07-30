import { test, expect } from '@playwright/test';

// Helper function to force cleanup BLE connections via WebSocket
async function forceCleanupBLE(wsUrl = 'ws://localhost:8080'): Promise<void> {
  return new Promise((resolve, reject) => {
    // In Playwright, we can use page.evaluate to create WebSocket in browser context
    const cleanup = async () => {
      const ws = new WebSocket(wsUrl);
      
      return new Promise<void>((resolveWs, rejectWs) => {
        const timeout = setTimeout(() => {
          ws.close();
          rejectWs(new Error('Force cleanup timeout'));
        }, 5000);
        
        ws.onopen = () => {
          console.log('Connected to bridge server');
          ws.send(JSON.stringify({ type: 'force_cleanup' }));
        };
        
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'force_cleanup_complete') {
            console.log('Force cleanup completed:', msg.message);
            clearTimeout(timeout);
            ws.close();
            resolveWs();
          }
        };
        
        ws.onerror = (error) => {
          clearTimeout(timeout);
          rejectWs(new Error('WebSocket error'));
        };
      });
    };
    
    cleanup().then(resolve).catch(reject);
  });
}

// Example Playwright test with force cleanup
test.describe('BLE Bridge E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Force cleanup any existing BLE connections before each test
    await page.evaluate(async (wsUrl) => {
      const ws = new WebSocket(wsUrl);
      
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Force cleanup timeout'));
        }, 5000);
        
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'force_cleanup' }));
        };
        
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'force_cleanup_complete') {
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        };
        
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('WebSocket error'));
        };
      });
    }, 'ws://localhost:8080');
    
    console.log('BLE cleanup completed, starting test...');
  });
  
  test('should connect to BLE device after force cleanup', async ({ page }) => {
    // Your test code here
    await page.goto('http://localhost:3000'); // Your app URL
    
    // Now you can be sure no stale BLE connections exist
    // Continue with your test...
  });
  
  // Alternative: Inline cleanup during test
  test('manual cleanup example', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Force cleanup at any point in your test
    await page.evaluate(() => {
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket('ws://localhost:8080');
        
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'force_cleanup' }));
        };
        
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'force_cleanup_complete') {
            ws.close();
            resolve();
          }
        };
        
        ws.onerror = () => reject(new Error('Cleanup failed'));
        
        setTimeout(() => {
          ws.close();
          reject(new Error('Cleanup timeout'));
        }, 5000);
      });
    });
    
    console.log('Cleanup done, continuing test...');
  });
});