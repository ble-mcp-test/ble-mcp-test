// Global teardown for all tests

export async function teardown() {
  // Give time for any in-flight async work to settle
  await new Promise(resolve => setTimeout(resolve, 1000));
}
