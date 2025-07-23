// Vitest setup file
// Ensures tests exit properly and don't hang

import { afterAll } from 'vitest';

// Global afterAll hook to ensure cleanup
afterAll(async () => {
  console.log('[Vitest Setup] Running global afterAll cleanup');
  
  // Import and cleanup Noble if available
  try {
    const { cleanupNoble } = await import('../dist/noble-transport.js');
    await cleanupNoble();
  } catch (error) {
    // Ignore if not available
  }
  
  // Wait a bit for cleanup to complete
  await new Promise(resolve => setTimeout(resolve, 500));
});