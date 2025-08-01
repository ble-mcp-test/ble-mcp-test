# Cache-Busting Strategies for ble-mcp-test

## The Problem

Browser and CDN caches can serve outdated versions of the `web-ble-mock.bundle.js` file, causing downstream users to run old code even after updating the npm package.

## Solutions

### 1. **Use Versioned Bundle Files** (Recommended)

Starting with v0.5.3, we provide versioned bundle files:

```html
<!-- Instead of this (can be cached): -->
<script src="node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js"></script>

<!-- Use this (version-specific): -->
<script src="node_modules/ble-mcp-test/dist/web-ble-mock.bundle.v0.5.3.js"></script>
```

### 2. **Add Query String with Version**

```html
<!-- Add package version as query param -->
<script src="node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js?v=0.5.3"></script>

<!-- Or use timestamp for development -->
<script src="node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js?t=1735744800000"></script>
```

### 3. **Use Dynamic Loading with Version Check**

```javascript
// Check version at runtime
import { version } from 'ble-mcp-test/package.json';

const script = document.createElement('script');
script.src = `node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js?v=${version}`;
document.head.appendChild(script);

script.onload = () => {
  // Verify version matches
  if (window.WebBleMock.version !== version) {
    console.error(`Version mismatch! Expected ${version}, got ${window.WebBleMock.version}`);
  }
};
```

### 4. **For Playwright/Test Environments**

```javascript
// In your test setup, force reload:
await page.addScriptTag({ 
  path: 'node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js',
  // Force browser to bypass cache
  content: `// Cache bust: ${Date.now()}`
});

// Or use page context options to disable cache:
const context = await browser.newContext({
  // Disable all caching
  bypassCSP: true,
  offline: false,
  httpCredentials: null,
  // Force reload resources
  extraHTTPHeaders: {
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  }
});
```

### 5. **Verify Bundle Version**

Always check the loaded version:

```javascript
// After loading the bundle
if (window.WebBleMock && window.WebBleMock.version) {
  console.log('Loaded ble-mcp-test version:', window.WebBleMock.version);
} else {
  console.error('Bundle version not available - may be using old cached version!');
}
```

### 6. **Clear Browser Cache During Development**

For development/debugging:
- Chrome DevTools → Network tab → Check "Disable cache"
- Or manually clear: Settings → Privacy → Clear browsing data → Cached images and files

### 7. **Use Import Maps (Modern Approach)**

```html
<script type="importmap">
{
  "imports": {
    "ble-mcp-test": "./node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js?v=0.5.3"
  }
}
</script>
```

## Best Practices

1. **Always use versioned URLs** in production
2. **Check `window.WebBleMock.version`** after loading
3. **Use timestamp query params** during development
4. **Configure test runners** to bypass cache
5. **Document the version** you're testing against

## Troubleshooting Cache Issues

If you suspect you're running an old cached version:

1. Check the version:
   ```javascript
   console.log('WebBleMock version:', window.WebBleMock?.version);
   ```

2. Force reload the page:
   - Windows/Linux: `Ctrl + Shift + R`
   - Mac: `Cmd + Shift + R`

3. Check Network tab in DevTools:
   - Look for 304 (Not Modified) responses
   - Check response headers for cache info

4. Add cache-busting query param:
   ```javascript
   const script = document.querySelector('script[src*="web-ble-mock.bundle.js"]');
   script.src = script.src.split('?')[0] + '?nocache=' + Date.now();
   ```