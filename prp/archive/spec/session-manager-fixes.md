## FEATURE:
- Review uncommitted changes in working tree. You have already some preliminary attempts at these features and fixes. Please carefully review and make sure that those changes are appropriate, and bring them forward if they are
- Add cache busting to the web mock bundle.
- Add the ability to check the version of the web mock bundle from test code
- Add a working minimal end to end test to the deployment bundle so that users can baseline their tests when they dont behave correctly

## REPORTED BUG:
- Server reports auto-generated session ID sent even though test browser console logging reports sending session id from local storage
  - While this bug has been difficult to reproduce, I consistently saw it on my downstream project. We need to be 100% sure that our implementation does not do this

## OTHER CONSIDERATIONS
- This will be version 0.5.3 for NPM publishing
