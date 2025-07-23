// Global teardown for all tests
// Ensures Noble and other resources are properly cleaned up

export async function teardown() {
  try {
    // Import and call Noble cleanup if available
    const { cleanupNoble } = await import('../dist/noble-transport.js');
    await cleanupNoble();
  } catch (error) {
    // Noble transport might not be built yet in some test scenarios
  }
  
  // Give time for cleanup
  await new Promise(resolve => setTimeout(resolve, 1000));
}