// Global teardown for all tests
// Ensures Noble and other resources are properly cleaned up

export async function teardown() {
  console.log('\n[Test Teardown] Starting global cleanup...');
  
  try {
    // Import and call Noble cleanup if available
    const { cleanupNoble } = await import('../dist/noble-transport.js');
    await cleanupNoble();
  } catch (error) {
    // Noble transport might not be built yet in some test scenarios
    console.log('[Test Teardown] Noble cleanup skipped:', error.message);
  }
  
  // Give time for cleanup
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('[Test Teardown] Cleanup complete');
}