## FIXES:
- Archive derministic session prp docs
- Thoroughly test recent server stabilization fixes
- Carefully review grace and idle timeout process flow. I continue to see zombie connections
- Enhance grace and idle disconnects to check for any remaining Noble resources and clean them up. I see cases where the connection pooling says there is no connection but Noble still has a connection and cannot reconnect
- The timeout clean up should run a scanner and confirm that the device is available. If it is not then log an error. We may add user notification for that in the future

## OTHER CONSIDERATIONS:
- Do not declare victory until E2E tests are passing
