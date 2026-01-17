# console-bridge-sveltekit

Forward frontend console logs to your SvelteKit backend for easier debugging. Perfect for AI agents and developers who want to see all logs in one place.

## Features

- ✅ Forward frontend console logs to backend
- ✅ See frontend + backend logs in single terminal
- ✅ Dev-only (zero production overhead)
- ✅ Batched requests for efficiency
- ✅ Recursive-safe
- ✅ Configurable log levels
- ✅ TypeScript support
- ✅ Stack trace capture for errors
- ✅ Capture fetch + XHR network calls
- ✅ Capture global errors/unhandled rejections
- ✅ Optional response body capture w limits
- ✅ URL include/ignore filters

## Installation

```bash
npm install console-bridge-sveltekit
# or
pnpm add console-bridge-sveltekit
# or
yarn add console-bridge-sveltekit
```

## Usage

### 1. Create API Endpoint

Create `src/routes/api/console-bridge/+server.ts`:

```typescript
import { createConsoleBridgeEndpoint } from 'console-bridge-sveltekit/server';

export const POST = createConsoleBridgeEndpoint();
```

### 2. Initialize in Layout

In `src/routes/+layout.svelte`:

```svelte
<script>
  import { onMount } from 'svelte';
  import { initConsolebridge } from 'console-bridge-sveltekit/client';

  onMount(() => {
    initConsolebridge();
  });
</script>
```

That's it! Now all frontend console logs will appear in your server terminal.

## Configuration

### Client Options

```typescript
initConsolebridge({
  endpoint: '/api/console-bridge',  // API endpoint
  batchSize: 10,                    // Logs per batch
  batchDelay: 100,                  // Batch delay (ms)
  levels: ['error', 'warn'],        // Only forward errors and warnings
  captureNetwork: true,             // Capture fetch/XHR
  captureErrors: true,              // Capture global errors
  networkBodyLimit: 500,            // Truncate response body length
  networkInclude: [],               // Only these URLs
  networkIgnore: []                 // Skip these URLs
});
```

### Server Options

```typescript
export const POST = createConsoleBridgeEndpoint({
  prefix: '[FRONTEND',  // Log prefix
  formatter: (level, url, timestamp, args) => {
    return `[CUSTOM] ${level} from ${url}`;
  },
  onLog: (level, url, timestamp, args) => {
    // Custom handler (e.g., send to external service)
    if (level === 'error') {
      sendToSentry(args);
    }
  }
});
```

## Example Output

**Browser console:**
```
Hello from frontend
```

**Server terminal:**
```
[FRONTEND LOG] http://localhost:5173/app/dashboard @ 2024-01-11T10:30:00.000Z Hello from frontend
```

## API

### Client

#### `initConsolebridge(options?)`

Initialize console bridge in browser.

**Options:**
- `endpoint?: string` - Backend endpoint (default: `/api/console-bridge`)
- `batchSize?: number` - Logs per batch (default: 10)
- `batchDelay?: number` - Batch delay in ms (default: 100)
- `levels?: LogLevel[]` - Log levels to forward (default: all)
- `captureNetwork?: boolean` - Forward fetch/XHR calls (default: true)
- `captureErrors?: boolean` - Forward global errors/rejections (default: true)
- `networkBodyLimit?: number` - Max body chars, 0 disables (default: 500)
- `networkInclude?: (string | RegExp)[]` - Include-only URL patterns (default: [])
- `networkIgnore?: (string | RegExp)[]` - Ignore URL patterns (default: [])

#### `restoreConsole()`

Restore original console methods.

### Server

#### `createConsoleBridgeEndpoint(options?)`

Create SvelteKit RequestHandler for console bridge.

**Options:**
- `prefix?: string` - Log prefix (default: `[FRONTEND`)
- `formatter?: (level, url, timestamp, args) => string` - Custom formatter
- `onLog?: (level, url, timestamp, args) => void` - Custom log handler

## Development

```bash
# Build
pnpm build

# Publish
npm publish
```

## License

MIT
