## FEATURE:
We are renaming this project from web-ble-bridge to ble-mcp-test and removing @trakrf scoping in npm
- name change summary
  - github
    - old: https://github.com/trakrf/web-ble-bridge
    - new: https://github.com/ble-mcp-test/ble-mcp-test
  - npm/package
    - old: @trakrf/web-ble-bridge
    - new: ble-mcp-test
  - version
    - old: 0.2.0
    - new: 0.3.0 (we did not yet publish this version)
- Update project content to reflect the new naming
  - Update package.json to reflect the new name with the scoping removed
  - Change package name in all code examples
  - Update package-lock files - Need to regenerate after name change
  - Update environment variable prefixes - Any env vars like WEB_BLE_BRIDGE_* should become BLE_MCP_TEST_*.
  - Add documentation of this name change to README.md, particularly the header and roadmap section
  - Add new header text in examples below to README.md 
  - Update any badges (CI, npm version, etc.) to point to new URLs
  - Search for old names in:
    - Documentation
    - Code comments
    - Example files
    - CHANGELOG.md (add rename note for v0.3.0)
- Update the github repo
  - Push and merge the content changes on the existing repo to provide a clean history that reflects the rename
  - Create the new github repo. This may be a manual or scripted process - see example script in prp/example
  - push to new repo
- Update NPM publishing
  - ** v0.3.0 has not yet been published to npm **
  - Publish new v0.3.0 package to top level ble-mcp-test package without the @trakrf scoping
  - Deprecate @trakrf/web-ble-bridge package with a redirect to the new package immediately after v0.3.0 published
- Out of scope:
  - CLI tools - we dont have any yet
  - Docker images - we dont have any yet
  - CI/CD - we have not built that yet
  - any and all previous spec docs and prompts in prp/archive
  - TrakRF sponsor links

## EXAMPLES:
- gh cli shell script suggested by claude desktop: prp/example/migrate-repo.sh

package.json
```
{
    "name": "ble-mcp-test",
    "version": "0.3.0",
    "description": "Bridge Bluetooth devices to your AI coding assistant via Model Context Protocol",
    "repository": {
        "type": "git",
        "url": "https://github.com/ble-mcp-test/ble-mcp-test.git"
    },
    "bugs": {
        "url": "https://github.com/ble-mcp-test/ble-mcp-test/issues"
    },
    "homepage": "https://github.com/ble-mcp-test/ble-mcp-test#readme"
}
```
README.md header
```
# ble-mcp-test
Bridge Bluetooth devices to your AI coding assistant via Model Context Protocol.
[BLE]──●──[MCP]──●──[AI agent]

```
CHANGELOG.md entry
```
## [0.3.0] - 2024-XX-XX
### Changed
- BREAKING: Renamed package from @trakrf/web-ble-bridge to ble-mcp-test
- Repository moved to https://github.com/ble-mcp-test/ble-mcp-test
```

