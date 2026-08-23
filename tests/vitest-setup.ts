// Vitest setup file
// Ensures tests exit properly and don't hang

import { afterAll } from 'vitest';

// Track if cleanup has already run to avoid multiple calls
let cleanupComplete = false;

// Global afterAll hook to ensure cleanup
afterAll(async () => {
  if (cleanupComplete) {
    return;
  }
  
  cleanupComplete = true;
  
  
  // Wait a bit for cleanup to complete
  await new Promise(resolve => setTimeout(resolve, 500));
}, 30000); // 30 second timeout for cleanup